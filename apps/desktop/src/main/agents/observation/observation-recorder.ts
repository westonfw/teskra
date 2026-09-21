import {
  agentObservationSchema,
  LIST_AGENT_OBSERVATIONS_DEFAULT_LIMIT,
  type AgentErrorObservation,
  type AgentObservation,
  type AgentObservationRecord,
  type AgentUsageObservation,
  type IpcResult,
  type ListAgentObservationsRequest,
  type StructuredOutputProtocol,
  type WorkbenchEvents,
} from '@teskra/contracts'

import type { AgentEventRepository } from '../../db/repositories/agent-event-repository'
import type { AgentRunRepository } from '../../db/repositories/agent-run-repository'
import type { EventBus } from '../../events/event-bus'
import { getLogger } from '../../logger'
import { redactSecrets } from '../../redact'
import type { RunLogStore } from '../run-log-store'
import type { RunWatchdogService } from '../run-watchdog-service'
import { normalizeClaudeStreamJsonLine } from './claude-stream-json'
import { normalizeCodexExecJsonLine } from './codex-exec-json'
import { createLineSplitter, type LineSplitter } from './line-splitter'
import type { ObservationNormalizer } from './normalize-shared'

/** TASK-123 (§6.2 / ADR-0013): the agent_events event types this module writes. */
export const OBSERVATION_EVENT_TYPE = 'agent.observation'
export const OBSERVATION_SUMMARY_EVENT_TYPE = 'agent.observation_summary'

type ObservationProtocol = Exclude<StructuredOutputProtocol, 'none'>
export type { ObservationProtocol }

const NORMALIZERS: Record<ObservationProtocol, ObservationNormalizer> = {
  'claude-stream-json': normalizeClaudeStreamJsonLine,
  'codex-exec-json': normalizeCodexExecJsonLine,
}

export interface ObservationRecorderDeps {
  readonly runLogs: Pick<RunLogStore, 'appendEvent'>
  readonly agentEvents: Pick<AgentEventRepository, 'append' | 'listByRunAndType'>
  /** `providerSession` backfill from session observations (metadata only). */
  readonly runs: Pick<AgentRunRepository, 'getById' | 'update'>
  readonly events: EventBus<WorkbenchEvents>
  /** TASK-119 entry: every observation refreshes the run's silence baseline. */
  readonly watchdog?: Pick<RunWatchdogService, 'noteActivity'>
  /**
   * TASK-124 hook: usage observations are reported here AFTER they are
   * persisted and broadcast. The `source` protocol is the attached parser's,
   * so the consumer can record it without re-deriving it from the agentType.
   */
  readonly onUsage?: (
    runId: string,
    usage: AgentUsageObservation,
    source: ObservationProtocol,
  ) => void
  readonly now?: () => string
}

/**
 * TASK-123 (Milestone 25 §6.2 / ADR-0013): parses the exec-mode structured
 * output stream of a run into AgentObservations and persists each as an
 * `agent.observation` event (events.jsonl + agent_events, same seq mechanism
 * as every agent.* event). Observation-only: parsing NEVER changes Run state,
 * never terminates the process, and every failure mode (unknown type, non-JSON
 * line, oversized line, a throwing normalizer) is swallowed into the ignored
 * tally that lands in `agent.observation_summary` when the run ends.
 */
export interface ObservationRecorder {
  /**
   * Starts parsing the run's output under the given protocol. Idempotent per
   * run; the AgentManager attaches BEFORE the adapter starts so no NDJSON
   * line is missed.
   */
  attach(runId: string, protocol: ObservationProtocol): void
  /**
   * Feeds one raw `process.output` chunk (BEFORE the 32ms output batcher).
   * No-op for runs without an attached parser. Never throws.
   */
  ingestChunk(runId: string, data: string): void
  /**
   * Processes the held incomplete tail line without finishing — called by the
   * AgentManager on process exit BEFORE failure classification, so an
   * unterminated final error line still lands in structuredErrorFor().
   */
  flush(runId: string): void
  /**
   * The latest redacted `error` observation of the run — the ADR-0010 §4
   * structured-error evidence handed to the FailureClassifier after exit.
   */
  structuredErrorFor(runId: string): AgentErrorObservation | undefined
  /** `teskra:agent:list-observations` — persisted events paged by seq. */
  list(request: ListAgentObservationsRequest): IpcResult<AgentObservationRecord[]>
  /** Detaches from the EventBus and drops all per-run state; idempotent. */
  dispose(): void
}

interface RunState {
  readonly protocol: ObservationProtocol
  readonly normalizer: ObservationNormalizer
  readonly splitter: LineSplitter
  /** Persisted observations (the summary's `parsed`). */
  parsed: number
  /** Dropped lines: bad JSON, unknown type, oversized (the summary's `ignored`). */
  ignored: number
  /** Splitter's cumulative droppedLines already folded into `ignored`. */
  countedDropped: number
  lastError?: AgentErrorObservation
  /** A throwing dependency WARNs once per run, then stays silent. */
  failureWarned: boolean
}

export function createObservationRecorder(deps: ObservationRecorderDeps): ObservationRecorder {
  const logger = getLogger('agent')
  const now = deps.now ?? (() => new Date().toISOString())
  const states = new Map<string, RunState>()
  let disposed = false

  const noteFailure = (runId: string, state: RunState, reason: string, cause?: unknown): void => {
    if (state.failureWarned) return
    state.failureWarned = true
    logger.warn(
      { runId, reason, cause },
      'Structured-output observation degraded for this run; affected lines are skipped and counted (this is the only warning for this run).',
    )
  }

  const backfillProviderSession = (runId: string, sessionId: string): void => {
    const run = deps.runs.getById(runId)
    if (!run.ok) {
      logger.error(
        { runId, error: run.error },
        'Failed to read the run for a providerSession backfill.',
      )
      return
    }
    if (run.data === null) return
    const existing = run.data.providerSession
    // 已存在不覆盖: an already-recorded session id always wins.
    if (typeof existing?.['sessionId'] === 'string' && existing['sessionId'].length > 0) return
    const provider =
      typeof existing?.['provider'] === 'string' && existing['provider'].length > 0
        ? existing['provider']
        : run.data.agentType
    const updated = deps.runs.update(
      runId,
      { providerSession: { ...(existing ?? {}), provider, sessionId } },
      now(),
    )
    if (!updated.ok) {
      logger.error(
        { runId, error: updated.error },
        'Failed to backfill the providerSession from a session observation.',
      )
    }
  }

  const persistAndBroadcast = (
    runId: string,
    state: RunState,
    observation: AgentObservation,
  ): void => {
    const timestamp = now()
    const redacted = redactSecrets(observation) as AgentObservation
    // Same seq mechanism as every agent.* event: events.jsonl first, then
    // agent_events with the file-aligned seq (TASK-039 ordering).
    const durable = deps.runLogs.appendEvent(runId, OBSERVATION_EVENT_TYPE, redacted, timestamp)
    if (!durable.ok) {
      logger.error(
        { runId, error: durable.error },
        'Failed to persist a durable observation event; the observation is dropped.',
      )
      return
    }
    const appended = deps.agentEvents.append(
      {
        runId,
        seq: durable.data.seq,
        eventType: OBSERVATION_EVENT_TYPE,
        payload: durable.data.payload,
      },
      timestamp,
    )
    if (!appended.ok) {
      logger.error(
        { runId, error: appended.error },
        'Failed to persist an observation event; the observation is dropped.',
      )
      return
    }
    state.parsed += 1
    deps.events.emit('agent.observation', { runId, seq: durable.data.seq, observation: redacted })
    deps.watchdog?.noteActivity(runId)
    if (redacted.kind === 'session') {
      backfillProviderSession(runId, redacted.sessionId)
    } else if (redacted.kind === 'tool_call' && redacted.command !== undefined) {
      // Structured source replaces the auditCommandPatterns regex for this run
      // (suppressed by the AgentManager at attach) — same bus event the regex
      // path emits, so the audit lands in the same agent.command stream.
      deps.events.emit('agent.command', { runId, command: redacted.command })
    } else if (redacted.kind === 'usage') {
      deps.onUsage?.(runId, redacted, state.protocol)
    } else if (redacted.kind === 'error') {
      state.lastError = redacted
    }
  }

  const handleLine = (runId: string, state: RunState, line: string): void => {
    const normalized = state.normalizer(line)
    if (normalized === undefined) {
      state.ignored += 1
      return
    }
    for (const observation of normalized.observations) {
      // The normalizers are trusted to honor the contracts schema; a line that
      // slips past (future protocol drift) is counted, never persisted raw.
      const validated = agentObservationSchema.safeParse(observation)
      if (!validated.success) {
        state.ignored += 1
        noteFailure(runId, state, 'normalized observation failed the schema')
        continue
      }
      persistAndBroadcast(runId, state, validated.data)
    }
  }

  /** Folds the splitter's cumulative oversized-line drops into the tally. */
  const syncDropped = (state: RunState): void => {
    state.ignored += state.splitter.droppedLines - state.countedDropped
    state.countedDropped = state.splitter.droppedLines
  }

  const ingestLines = (runId: string, state: RunState, lines: readonly string[]): void => {
    for (const line of lines) {
      handleLine(runId, state, line)
    }
    syncDropped(state)
  }

  const attach = (runId: string, protocol: ObservationProtocol): void => {
    if (disposed || states.has(runId)) return
    states.set(runId, {
      protocol,
      normalizer: NORMALIZERS[protocol],
      splitter: createLineSplitter(),
      parsed: 0,
      ignored: 0,
      countedDropped: 0,
      failureWarned: false,
    })
  }

  const writeSummary = (runId: string, state: RunState): void => {
    const timestamp = now()
    const payload = { parsed: state.parsed, ignored: state.ignored }
    const durable = deps.runLogs.appendEvent(
      runId,
      OBSERVATION_SUMMARY_EVENT_TYPE,
      payload,
      timestamp,
    )
    if (!durable.ok) {
      logger.error(
        { runId, error: durable.error },
        'Failed to persist the durable observation summary.',
      )
    } else {
      const appended = deps.agentEvents.append(
        {
          runId,
          seq: durable.data.seq,
          eventType: OBSERVATION_SUMMARY_EVENT_TYPE,
          payload: durable.data.payload,
        },
        timestamp,
      )
      if (!appended.ok) {
        logger.error({ runId, error: appended.error }, 'Failed to persist the observation summary.')
      }
    }
    deps.events.emit('agent.observation_summary', { runId, ...payload })
  }

  const flush = (runId: string): void => {
    const state = states.get(runId)
    if (state === undefined) return
    try {
      const tail = state.splitter.flush()
      if (tail !== undefined) handleLine(runId, state, tail)
      syncDropped(state)
    } catch (cause) {
      noteFailure(runId, state, 'flush threw', cause)
    }
  }

  const finish = (runId: string): void => {
    const state = states.get(runId)
    if (state === undefined) return
    flush(runId)
    states.delete(runId)
    writeSummary(runId, state)
  }

  const stopTerminal = (
    ['agent.completed', 'agent.failed', 'agent.cancelled', 'agent.interrupted'] as const
  ).map((name) => deps.events.subscribe(name, ({ runId }) => finish(runId)))

  return {
    attach,
    ingestChunk(runId, data) {
      if (disposed) return
      const state = states.get(runId)
      if (state === undefined) return
      try {
        ingestLines(runId, state, state.splitter.push(data))
      } catch (cause) {
        // ADR-0013 §5: a parser failure is normal — count and carry on; the
        // Run itself is never touched.
        state.ignored += 1
        noteFailure(runId, state, 'ingest threw', cause)
      }
    },
    flush(runId) {
      if (disposed) return
      flush(runId)
    },
    structuredErrorFor(runId) {
      return states.get(runId)?.lastError
    },
    list(request) {
      const listed = deps.agentEvents.listByRunAndType(request.runId, OBSERVATION_EVENT_TYPE, {
        ...(request.afterSeq === undefined ? {} : { afterSeq: request.afterSeq }),
        limit: request.limit ?? LIST_AGENT_OBSERVATIONS_DEFAULT_LIMIT,
      })
      if (!listed.ok) return listed
      const records: AgentObservationRecord[] = []
      for (const row of listed.data) {
        // Written through persistAndBroadcast, so payloads re-validate; a row
        // that no longer parses is skipped rather than failing the page.
        const observation = agentObservationSchema.safeParse(row.payload)
        if (!observation.success) continue
        records.push({ seq: row.seq, observation: observation.data, createdAt: row.createdAt })
      }
      return { ok: true, data: records }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const stop of stopTerminal) stop()
      states.clear()
    },
  }
}
