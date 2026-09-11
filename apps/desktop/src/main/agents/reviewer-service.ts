import { randomUUID } from 'node:crypto'

import type {
  IpcResult,
  ReviewRunStartResult,
  StartReviewRunRequest,
  WorkbenchEvents,
} from '@teskra/contracts'

import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { Worktree, WorktreeRepository } from '../db/repositories/worktree-repository'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import type { WorktreeManager } from '../git/worktree-manager'
import { getLogger } from '../logger'
import type { AgentManager } from './agent-manager'
import type { AgentRegistry } from './agent-registry'

export interface ReviewerService {
  startReview(request: StartReviewRunRequest): Promise<IpcResult<ReviewRunStartResult>>
  dispose(): void
}

export interface ReviewerServiceDeps {
  readonly registry: AgentRegistry
  readonly agents: AgentManager
  readonly worktreeManager: WorktreeManager
  readonly runs: AgentRunRepository
  readonly worktrees: WorktreeRepository
  readonly events: EventBus<WorkbenchEvents>
  readonly createRunId?: () => string
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function invalid<T>(message: string, detail: string): IpcResult<T> {
  return fail({ code: 'VALIDATION_FAILED', message, retryable: false, detail })
}

/**
 * Reviewer role launch policy (TASK-052; plan §103/§126; ADR-0002).
 *
 * This logic lives in a dedicated service rather than inside
 * AgentManager.start: choosing an isolation tier requires creating worktrees,
 * and AgentManager deliberately owns only Run lifecycle (it reads the
 * WorktreeRepository but never runs git). ReviewerService composes
 * WorktreeManager + AgentManager, the same way MergeService composes
 * WorktreeManager + repositories.
 *
 * Isolation tier decision (ReviewIsolation, plan §126):
 *
 * - capabilities.readOnlyMode === true → the CLI can enforce read-only, so the
 *   read-only boundary is policy projection (ADR-0002): the run is always
 *   started with approvalMode 'read-only', which each Adapter translates into
 *   its CLI's own read-only mechanism (Codex `--sandbox read-only`, Claude
 *   `--permission-mode plan`). With a resolvable review target the Reviewer
 *   runs inside the implement worktree ('worktree-readonly'); otherwise in the
 *   main workspace ('shared-readonly'). A reviewer run is NEVER writable, so
 *   the caller cannot pass approvalMode.
 * - capabilities.readOnlyMode === false → the CLI cannot be trusted to stay
 *   read-only, and "please don't modify files" prompts are not a boundary
 *   (§126). Instead the environment provides it: a disposable-snapshot
 *   worktree (based on the review target's branch, so committed implement
 *   changes are reviewable) the Agent may freely modify, discarded whole once
 *   the review ends.
 *
 * Snapshot cleanup is event-driven: on any terminal run event of a reviewer
 * run bound to a disposable-snapshot worktree, the snapshot is discarded
 * (best-effort; failures are logged and left to TASK-047 cleanup). AgentManager
 * collects the handoff before emitting terminal events, and handoff/artifact
 * files live in the Run directory — never in the worktree — so discarding the
 * snapshot cannot destroy review output (ADR-0004).
 */
export function createReviewerService(deps: ReviewerServiceDeps): ReviewerService {
  const logger = getLogger('agent')
  const createRunId = deps.createRunId ?? randomUUID

  const lookupWorktree = (worktreeId: string, workspaceId: string): IpcResult<Worktree> => {
    const found = deps.worktrees.getById(worktreeId)
    if (!found.ok) return found
    if (found.data === null) {
      return invalid(
        `Worktree "${worktreeId}" was not found.`,
        `ReviewerService could not resolve worktree id=${JSON.stringify(worktreeId)}`,
      )
    }
    if (found.data.workspaceId !== workspaceId) {
      return invalid(
        'The review target worktree belongs to a different workspace.',
        `worktree workspace=${found.data.workspaceId} review workspace=${workspaceId}`,
      )
    }
    return { ok: true, data: found.data }
  }

  /** Most specific reference wins; no reference at all means shared review. */
  const resolveTarget = (
    request: StartReviewRunRequest,
  ): IpcResult<{ worktree: Worktree | null; runId?: string }> => {
    if (request.targetWorktreeId !== undefined) {
      const worktree = lookupWorktree(request.targetWorktreeId, request.workspaceId)
      if (!worktree.ok) return worktree
      return {
        ok: true,
        data: {
          worktree: worktree.data,
          ...(worktree.data.runId === undefined ? {} : { runId: worktree.data.runId }),
        },
      }
    }
    if (request.targetRunId !== undefined) {
      const run = deps.runs.getById(request.targetRunId)
      if (!run.ok) return run
      if (run.data === null) {
        return invalid(
          `Agent run "${request.targetRunId}" was not found.`,
          `ReviewerService could not resolve target run id=${JSON.stringify(request.targetRunId)}`,
        )
      }
      if (run.data.workspaceId !== request.workspaceId) {
        return invalid(
          'The review target run belongs to a different workspace.',
          `run workspace=${run.data.workspaceId} review workspace=${request.workspaceId}`,
        )
      }
      if (run.data.worktreeId === undefined) {
        return { ok: true, data: { worktree: null, runId: run.data.id } }
      }
      const worktree = lookupWorktree(run.data.worktreeId, request.workspaceId)
      if (!worktree.ok) return worktree
      return { ok: true, data: { worktree: worktree.data, runId: run.data.id } }
    }
    if (request.taskId !== undefined) {
      const taskRuns = deps.runs.listByTask(request.taskId)
      if (!taskRuns.ok) return taskRuns
      // Reviewer runs are excluded: a snapshot reviewer's worktree is
      // discarded when the review ends, and a worktree-readonly reviewer's
      // worktree is the implement worktree itself — targeting either would
      // review a deleted scratch copy instead of the implement output
      // (ReviewPanelService.resolveImplementRunId applies the same rule).
      const latest = taskRuns.data
        .filter(
          (run) =>
            run.workspaceId === request.workspaceId &&
            run.worktreeId !== undefined &&
            run.role !== 'reviewer',
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      if (latest?.worktreeId === undefined) {
        return { ok: true, data: { worktree: null } }
      }
      const worktree = lookupWorktree(latest.worktreeId, request.workspaceId)
      if (!worktree.ok) return worktree
      return { ok: true, data: { worktree: worktree.data, runId: latest.id } }
    }
    return { ok: true, data: { worktree: null } }
  }

  const discardSnapshot = (worktreeId: string, runId: string): void => {
    void deps.worktreeManager
      .discard({ worktreeId, confirm: true })
      .then((discarded) => {
        if (!discarded.ok) {
          logger.error(
            { runId, worktreeId, error: discarded.error },
            'Failed to discard disposable review snapshot; left for worktree cleanup.',
          )
        }
      })
      .catch((cause: unknown) => {
        logger.error({ runId, worktreeId, cause }, 'Disposable review snapshot discard threw.')
      })
  }

  const cleanupFinishedReview = (runId: string): void => {
    const run = deps.runs.getById(runId)
    if (!run.ok || run.data === null) return
    if (run.data.role !== 'reviewer' || run.data.worktreeId === undefined) return
    const worktree = deps.worktrees.getById(run.data.worktreeId)
    if (!worktree.ok || worktree.data === null) return
    if (worktree.data.isolation !== 'disposable-snapshot') return
    if (worktree.data.state === 'discarded') return
    discardSnapshot(worktree.data.id, runId)
  }

  const subscriptions = [
    deps.events.subscribe('agent.completed', ({ runId }) => cleanupFinishedReview(runId)),
    deps.events.subscribe('agent.failed', ({ runId }) => cleanupFinishedReview(runId)),
    deps.events.subscribe('agent.cancelled', ({ runId }) => cleanupFinishedReview(runId)),
  ]

  return {
    async startReview(request) {
      const definition = deps.registry.get(request.agentType)
      if (definition === undefined) {
        return invalid(
          `Agent "${request.agentType}" is not registered.`,
          `ReviewerService could not resolve agentType=${JSON.stringify(request.agentType)}`,
        )
      }
      const target = resolveTarget(request)
      if (!target.ok) return target
      const worktree = target.data.worktree
      // TASK-054: the reviewer echoes this id as the handoff's targetRunId so
      // criterion scores are attributed to the reviewed Run (merge preflight
      // reads scores off the worktree's Run, not the reviewer Run). Teskra's
      // own attribution wins over a caller-supplied environment entry.
      const environment = {
        ...request.environment,
        ...(target.data.runId === undefined
          ? {}
          : { TESKRA_REVIEW_TARGET_RUN_ID: target.data.runId }),
      }
      const environmentField =
        Object.keys(environment).length === 0 ? {} : { environment }

      if (definition.capabilities.readOnlyMode) {
        const isolation = worktree === null ? 'shared-readonly' : 'worktree-readonly'
        const started = await deps.agents.start({
          workspaceId: request.workspaceId,
          agentType: definition.id,
          role: 'reviewer',
          approvalMode: 'read-only',
          ...(request.runId === undefined ? {} : { runId: request.runId }),
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
          ...(worktree === null ? {} : { worktreeId: worktree.id }),
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.mode === undefined ? {} : { mode: request.mode }),
          ...(request.executionMode === undefined ? {} : { executionMode: request.executionMode }),
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
          ...environmentField,
        })
        return started.ok ? { ok: true, data: { run: started.data, isolation } } : started
      }

      // The CLI cannot enforce read-only: the snapshot worktree is the only
      // write boundary, so no approvalMode is forced — the Agent's own default
      // applies, and anything it does is thrown away with the snapshot.
      const runId = request.runId ?? createRunId()
      const snapshot = await deps.worktreeManager.create({
        workspaceId: request.workspaceId,
        runId,
        agentId: definition.id,
        isolation: 'disposable-snapshot',
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        // Base the snapshot on the review target's branch so committed
        // implement changes are visible; uncommitted changes are not copied.
        ...(worktree === null ? {} : { baseBranch: worktree.branch }),
      })
      if (!snapshot.ok) return snapshot
      const started = await deps.agents.start({
        runId,
        workspaceId: request.workspaceId,
        agentType: definition.id,
        role: 'reviewer',
        worktreeId: snapshot.data.id,
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.mode === undefined ? {} : { mode: request.mode }),
        ...(request.executionMode === undefined ? {} : { executionMode: request.executionMode }),
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        ...environmentField,
      })
      if (!started.ok) {
        // Compensating action: never leave an orphan snapshot behind.
        discardSnapshot(snapshot.data.id, runId)
        return started
      }
      return { ok: true, data: { run: started.data, isolation: 'disposable-snapshot' } }
    },

    dispose() {
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
    },
  }
}
