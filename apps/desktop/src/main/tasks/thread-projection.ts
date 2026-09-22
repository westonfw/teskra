import { readFileSync } from 'node:fs'

import type {
  AgentProgressEvent,
  IpcResult,
  TaskThreadRequest,
  TaskThreadResponse,
  ThreadAgentReplyItem,
  ThreadItem,
} from '@teskra/contracts'
import {
  AGENT_REPLY_TEXT_MAX,
  TASK_THREAD_DEFAULT_LIMIT,
  TERMINAL_REPLY_TAIL_MAX,
  agentObservationSchema,
  agentProgressEventSchema,
} from '@teskra/contracts'

import type { DecisionRepository } from '../decisions/decision-repository'
import type { AgentEvent, AgentEventRepository } from '../db/repositories/agent-event-repository'
import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { Handoff, HandoffRepository } from '../db/repositories/handoff-repository'
import type { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { type InternalAppError, toPublicError } from '../errors'
import type { TeskraPaths } from '../paths'

/**
 * ThreadProjection (TASK-138, teskra-tasks.md; Milestone 26 design §5/§8) —
 * the read-only projection of a Task's thread behind `teskra:task:thread`.
 *
 * It is a pure read model: no table is created and nothing is written. Every
 * request batch-reads the five sources through Repository methods (the
 * Manager/projection layer never touches SQL) and merges them into
 * ThreadItems sorted by the stable `(createdAt, id)` cursor:
 *
 * - `user_message`   ← agent_runs.prompt (the message that started the Run)
 * - `agent_reply`    ← assistant_text observations joined by seq (32 KiB cap,
 *                      truncated flag), falling back to the Handoff summary,
 *                      then to the terminal.log tail (source 'terminal')
 * - `agent_progress` ← agent.progress events (ADR-0012)
 * - `decision`       ← pending_decisions of the task's runs / workflow runs
 *                      (open and resolved alike, ADR-0014)
 * - `system`         ← reviewer-role runs (Review), workflow_runs (Workflow),
 *                      interactive runs (one "running in the terminal" entry)
 *                      and failed/cancelled/interrupted status changes
 *
 * Workflow-owned runs fold into their Workflow card (§5), so they do not
 * emit per-run thread items; their decisions still surface individually.
 * Interactive runs (mode 'interactive', including pre-ADR-0007 rows without
 * a persisted mode) collapse to a single terminal system item — their raw
 * TUI lives in the Terminal tab, not the thread (§5).
 */

const OBSERVATION_EVENT_TYPE = 'agent.observation'
const PROGRESS_EVENT_TYPE = 'agent.progress'

/** Status changes worth a system item; 'completed' is implied by the reply. */
const NOTABLE_TERMINAL_STATUSES = new Set(['failed', 'cancelled', 'interrupted'])

const CURSOR_SEPARATOR = '|'

export interface ThreadProjectionDeps {
  readonly runs: Pick<AgentRunRepository, 'listByTask'>
  readonly workflowRuns: Pick<WorkflowRunRepository, 'listRunsByTask'>
  readonly handoffs: Pick<HandoffRepository, 'listByRuns'>
  readonly agentEvents: Pick<AgentEventRepository, 'listByRunsAndTypes'>
  readonly decisions: Pick<DecisionRepository, 'listByRuns'>
  readonly paths: Pick<TeskraPaths, 'runFiles'>
}

export interface ThreadProjection {
  getThread(request: TaskThreadRequest): IpcResult<TaskThreadResponse>
}

interface ThreadCursor {
  readonly createdAt: string
  readonly id: string
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function encodeCursor(item: ThreadItem): string {
  return `${item.createdAt}${CURSOR_SEPARATOR}${item.id}`
}

/** Item ids are projection-generated and never contain the separator. */
function decodeCursor(raw: string): ThreadCursor | undefined {
  const separator = raw.indexOf(CURSOR_SEPARATOR)
  if (separator <= 0 || separator === raw.length - 1) {
    return undefined
  }
  return {
    createdAt: raw.slice(0, separator),
    id: raw.slice(separator + CURSOR_SEPARATOR.length),
  }
}

function compareItems(left: ThreadItem, right: ThreadItem): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1
  }
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

/** Join assistant_text observations in seq order with the §8 32 KiB cap. */
function joinAssistantTexts(events: readonly AgentEvent[]): {
  text: string
  truncated: boolean
  createdAt: string
} {
  const texts: string[] = []
  let lastCreatedAt = events[events.length - 1]?.createdAt ?? ''
  for (const event of events) {
    const observation = agentObservationSchema.safeParse(event.payload)
    // Persisted through the recorder, so payloads re-validate; a row that no
    // longer parses is skipped rather than failing the page.
    if (!observation.success || observation.data.kind !== 'assistant_text') continue
    texts.push(observation.data.text)
    lastCreatedAt = event.createdAt
  }
  const joined = texts.join('')
  if (joined.length <= AGENT_REPLY_TEXT_MAX) {
    return { text: joined, truncated: false, createdAt: lastCreatedAt }
  }
  return { text: joined.slice(0, AGENT_REPLY_TEXT_MAX), truncated: true, createdAt: lastCreatedAt }
}

/**
 * The handoff fallback (§8): any payload with a string `summary` supplies the
 * reply body; the collector's terminal.log fallback rows keep their
 * `source: 'terminal.log'` marker, which maps to reply source 'terminal'.
 */
function handoffReplyBody(
  handoff: Handoff | undefined,
): { text: string; source: 'handoff' | 'terminal' } | undefined {
  const summary = handoff?.payload?.['summary']
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    return undefined
  }
  return {
    text: summary,
    source: handoff?.payload?.['source'] === 'terminal.log' ? 'terminal' : 'handoff',
  }
}

export function createThreadProjection(deps: ThreadProjectionDeps): ThreadProjection {
  /** The handoff-collector fallback rule: the trimmed terminal.log tail. */
  const readTerminalTail = (runId: string): string | undefined => {
    const files = deps.paths.runFiles(runId)
    if (!files.ok) {
      return undefined
    }
    let log: string
    try {
      log = readFileSync(files.data.terminal, 'utf8')
    } catch {
      return undefined
    }
    const tail = log.slice(-TERMINAL_REPLY_TAIL_MAX).trim()
    return tail.length > 0 ? tail : undefined
  }

  const buildReply = (
    run: { id: string; agentType: string; finishedAt?: string | undefined; updatedAt: string },
    runEvents: readonly AgentEvent[],
    handoff: Handoff | undefined,
  ): ThreadAgentReplyItem | undefined => {
    const base = { kind: 'agent_reply' as const, id: `reply:${run.id}`, runId: run.id }
    const observationEvents = runEvents.filter(
      (event) => event.eventType === OBSERVATION_EVENT_TYPE,
    )
    if (observationEvents.length > 0) {
      const joined = joinAssistantTexts(observationEvents)
      // A structured stream without assistant text is "no reply body" — the
      // handoff / terminal fallbacks still apply below.
      if (joined.text.length > 0) {
        return {
          ...base,
          createdAt: joined.createdAt,
          agentType: run.agentType,
          text: joined.text,
          source: 'observation',
          truncated: joined.truncated,
        }
      }
    }
    const fromHandoff = handoffReplyBody(handoff)
    if (fromHandoff !== undefined && handoff !== undefined) {
      return {
        ...base,
        createdAt: handoff.createdAt,
        agentType: run.agentType,
        text: fromHandoff.text,
        source: fromHandoff.source,
        truncated: false,
      }
    }
    const tail = readTerminalTail(run.id)
    if (tail === undefined) return undefined
    return {
      ...base,
      createdAt: run.finishedAt ?? run.updatedAt,
      agentType: run.agentType,
      text: tail,
      source: 'terminal',
      truncated: false,
    }
  }

  return {
    getThread(request) {
      let after: ThreadCursor | undefined
      if (request.afterCursor !== undefined) {
        after = decodeCursor(request.afterCursor)
        if (after === undefined) {
          return fail({
            code: 'VALIDATION_FAILED',
            message: 'The thread cursor is not valid.',
            retryable: false,
            detail: `thread-projection: undecodable afterCursor ${JSON.stringify(request.afterCursor)}`,
          })
        }
      }
      const limit = request.limit ?? TASK_THREAD_DEFAULT_LIMIT

      const runs = deps.runs.listByTask(request.taskId)
      if (!runs.ok) return runs
      const workflowRuns = deps.workflowRuns.listRunsByTask(request.taskId)
      if (!workflowRuns.ok) return workflowRuns

      const runIds = runs.data.map((run) => run.id)
      const events = deps.agentEvents.listByRunsAndTypes(runIds, [
        OBSERVATION_EVENT_TYPE,
        PROGRESS_EVENT_TYPE,
      ])
      if (!events.ok) return events
      const handoffs = deps.handoffs.listByRuns(runIds)
      if (!handoffs.ok) return handoffs
      const decisions = deps.decisions.listByRuns([
        ...runIds,
        ...workflowRuns.data.map((run) => run.id),
      ])
      if (!decisions.ok) return decisions

      const eventsByRun = new Map<string, AgentEvent[]>()
      for (const event of events.data) {
        const bucket = eventsByRun.get(event.runId)
        if (bucket === undefined) {
          eventsByRun.set(event.runId, [event])
        } else {
          bucket.push(event)
        }
      }
      const handoffByRun = new Map(handoffs.data.map((handoff) => [handoff.runId, handoff]))

      const items: ThreadItem[] = []
      for (const run of runs.data) {
        // Workflow-owned runs fold into the Workflow system card (§5).
        if (run.workflowRunId !== undefined) continue
        if (run.role === 'reviewer') {
          items.push({
            kind: 'system',
            id: `system:review:${run.id}`,
            createdAt: run.createdAt,
            systemKind: 'review',
            runId: run.id,
            status: run.status,
            text: 'Review run',
          })
          continue
        }
        // §5: an interactive run renders its own TUI in the Terminal tab —
        // the thread shows one linked system item instead of a reply.
        if (run.mode !== 'exec') {
          items.push({
            kind: 'system',
            id: `system:terminal:${run.id}`,
            createdAt: run.createdAt,
            systemKind: 'terminal',
            runId: run.id,
            status: run.status,
            text: 'Running in the terminal',
          })
          continue
        }
        if (run.prompt !== undefined && run.prompt.length > 0) {
          items.push({
            kind: 'user_message',
            id: `user:${run.id}`,
            createdAt: run.createdAt,
            runId: run.id,
            text: run.prompt,
          })
        }
        const reply = buildReply(run, eventsByRun.get(run.id) ?? [], handoffByRun.get(run.id))
        if (reply !== undefined) {
          items.push(reply)
        }
        for (const event of eventsByRun.get(run.id) ?? []) {
          if (event.eventType !== PROGRESS_EVENT_TYPE) continue
          const progress = agentProgressEventSchema.safeParse(event.payload)
          if (!progress.success) continue
          items.push({
            kind: 'agent_progress',
            id: `progress:${String(event.id)}`,
            createdAt: event.createdAt,
            runId: run.id,
            event: progress.data satisfies AgentProgressEvent,
          })
        }
        if (NOTABLE_TERMINAL_STATUSES.has(run.status)) {
          items.push({
            kind: 'system',
            id: `system:status:${run.id}`,
            createdAt: run.finishedAt ?? run.updatedAt,
            systemKind: 'status',
            runId: run.id,
            status: run.status,
            text: `Run ${run.status}`,
          })
        }
      }

      for (const workflowRun of workflowRuns.data) {
        items.push({
          kind: 'system',
          id: `system:workflow:${workflowRun.id}`,
          createdAt: workflowRun.createdAt,
          systemKind: 'workflow',
          workflowRunId: workflowRun.id,
          status: workflowRun.status,
          text: `Workflow ${workflowRun.workflowDefinitionId}`,
        })
      }

      for (const decision of decisions.data) {
        items.push({
          kind: 'decision',
          id: `decision:${decision.id}`,
          createdAt: decision.createdAt,
          decisionId: decision.id,
          ...(decision.runId === undefined ? {} : { runId: decision.runId }),
          ...(decision.workflowRunId === undefined
            ? {}
            : { workflowRunId: decision.workflowRunId }),
          decisionKind: decision.kind,
          severity: decision.severity,
          status: decision.status,
          title: decision.title,
          options: decision.options,
          ...(decision.resolution === undefined ? {} : { resolution: decision.resolution }),
        })
      }

      items.sort(compareItems)
      const window =
        after === undefined
          ? items
          : items.filter(
              (item) =>
                item.createdAt > after.createdAt ||
                (item.createdAt === after.createdAt && item.id > after.id),
            )
      const page = window.slice(0, limit)
      const last = page[page.length - 1]
      return {
        ok: true,
        data: {
          items: page,
          ...(window.length > limit && last !== undefined
            ? { nextCursor: encodeCursor(last) }
            : {}),
        },
      }
    },
  }
}
