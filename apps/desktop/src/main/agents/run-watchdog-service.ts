import type {
  AgentFailureClassification,
  AgentRun,
  IpcResult,
  WatchdogConfig,
  WorkbenchEvents,
} from '@teskra/contracts'
import { inspectRunWatchdog } from '@teskra/shared'

import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { AgentManager } from './agent-manager'

/**
 * RunWatchdogService (TASK-119, teskra-tasks.md; Milestone 25 design doc §5).
 *
 * The ONLY periodic task in the Main process: a single 15s interval scanning
 * the active runs (runs.listActive) with two checks, both judged through the
 * shared TASK-085 pure function / its documented rules — no second judgement:
 *
 * - preparing timeout (§5.2): `status === 'preparing'` and
 *   `now - updatedAt >= watchdog.preparingTimeoutMs` →
 *   `failAndStop(runId, { kind: 'process-crash', retryable: true })`.
 *   `created` (not launched yet) and `queued` (waiting is legal) never count.
 *   A CONFLICT answer (the launch is still in-flight, P0-3) is logged and
 *   retried on the next tick; three CONSECUTIVE conflicts escalate to an
 *   `agent.stalled` event and the watchdog stops forcing this run.
 * - idle watchdog (§5.3): `inspectRunWatchdog(run, now, watchdog.idleTimeoutMs)`
 *   over running / waiting_* / reviewing runs (idleTimeoutMs 0 disables it).
 *   `idleAction: 'stop'` fails the run; `'ask'` only emits `agent.stalled`
 *   once per stall episode — opening a Decision is TASK-130's job.
 *
 * The watchdog never touches a process itself — every action goes through
 * AgentManager.failAndStop/cancel. No electron import.
 *
 * Activity baseline: PTY output (`agent.output` events), agent.progress
 * (TASK-126) and agent.observation (TASK-123) all refresh a run's silence
 * baseline through noteActivity(); a user's "keep waiting" choice persists
 * `agent_runs.last_input_at` through acknowledgeIdle() (the column already
 * exists since migration 002; its semantics are exactly "last user
 * intervention", §5.3).
 */

export const WATCHDOG_TICK_MS = 15_000

/** §5.2: consecutive in-flight-launch CONFLICTs before escalating to agent.stalled. */
export const WATCHDOG_MAX_PREPARING_CONFLICTS = 3

export interface RunWatchdogService {
  /**
   * Refresh the run's silence baseline to now. PTY output is already wired;
   * TASK-123 / TASK-126 call the same entry from their observation / progress
   * paths.
   */
  noteActivity(runId: string): void
  /**
   * The user chose "keep waiting" for this run: persist
   * `agent_runs.last_input_at = now` so the next idle judgement starts from
   * this baseline (§5.3).
   */
  acknowledgeIdle(runId: string): IpcResult<void>
  /** Stops the timer and detaches from the EventBus; idempotent. */
  dispose(): void
}

export interface RunWatchdogServiceDeps {
  readonly runs: Pick<AgentRunRepository, 'listActive' | 'update'>
  readonly agents: Pick<AgentManager, 'failAndStop'>
  readonly events: EventBus<WorkbenchEvents>
  /** Watchdog config resolved per workspace through the Config Layers. */
  readonly resolveConfig: (workspaceId: string) => IpcResult<WatchdogConfig>
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

/** The latest of several optional ISO timestamps, or undefined. */
function latestTimestamp(...values: (string | undefined)[]): string | undefined {
  let latest: string | undefined
  let latestMs = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (value === undefined) continue
    const ms = Date.parse(value)
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms
      latest = value
    }
  }
  return latest
}

export function createRunWatchdogService(deps: RunWatchdogServiceDeps): RunWatchdogService {
  const logger = getLogger('agent')
  /** runId → consecutive failAndStop CONFLICT count (preparing check, §5.2). */
  const preparingConflicts = new Map<string, number>()
  /** Runs escalated to agent.stalled after MAX consecutive conflicts — no more force-stops. */
  const preparingEscalated = new Set<string>()
  /** Runs whose current stall episode already emitted agent.stalled / attempted a stop. */
  const stalledNotified = new Set<string>()
  /** runId → ISO baseline refreshed by noteActivity (PTY output now; TASK-123/126 later). */
  const notedActivity = new Map<string, string>()
  let ticking = false
  let disposed = false

  const noteActivity = (runId: string): void => {
    if (disposed) return
    notedActivity.set(runId, new Date().toISOString())
    // Fresh output ends the current stall episode: a later stall re-notifies.
    stalledNotified.delete(runId)
  }

  const stopOutput = deps.events.subscribe('agent.output', ({ runId }) => noteActivity(runId))

  const checkPreparing = async (
    run: AgentRun,
    config: WatchdogConfig,
    nowMs: number,
  ): Promise<void> => {
    if (run.status !== 'preparing') return
    const silentForMs = Math.max(0, nowMs - Date.parse(run.updatedAt))
    if (silentForMs < config.preparingTimeoutMs) return
    if (preparingEscalated.has(run.id)) return
    deps.events.emit('agent.watchdog', { runId: run.id, check: 'preparing_timeout', silentForMs })
    const classification: AgentFailureClassification = {
      kind: 'process-crash',
      retryable: true,
      evidence: `preparing timed out after ${String(Math.round(silentForMs / 1000))}s`,
    }
    const stopped = await deps.agents.failAndStop(run.id, classification)
    if (stopped.ok) {
      preparingConflicts.delete(run.id)
      return
    }
    if (stopped.error.code !== 'CONFLICT') {
      // Not the in-flight-launch guard — a real stop failure; breaks the
      // consecutive-conflict streak, retried on the next tick.
      preparingConflicts.delete(run.id)
      logger.error(
        { runId: run.id, error: stopped.error },
        'Run watchdog failed to stop a timed-out preparing run.',
      )
      return
    }
    // P0-3: adapter.start is still in flight — never settle the row under it.
    const conflicts = (preparingConflicts.get(run.id) ?? 0) + 1
    preparingConflicts.set(run.id, conflicts)
    logger.warn(
      { runId: run.id, conflicts },
      'Preparing run timed out but its launch is still in flight; retrying on the next tick.',
    )
    if (conflicts >= WATCHDOG_MAX_PREPARING_CONFLICTS) {
      preparingConflicts.delete(run.id)
      preparingEscalated.add(run.id)
      deps.events.emit('agent.stalled', { runId: run.id, silentForMs, action: 'ask' })
      logger.error(
        { runId: run.id, conflicts },
        'Preparing run stayed un-stoppable; escalated to agent.stalled and no longer force-stopped.',
      )
    }
  }

  const checkIdle = async (run: AgentRun, config: WatchdogConfig, nowMs: number): Promise<void> => {
    if (config.idleTimeoutMs === 0) return
    const inspection = inspectRunWatchdog(
      {
        status: run.status,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        // §5.3: the silence baseline is the latest of output, user input
        // (acknowledgeIdle persists last_input_at) and noted activity.
        lastOutputAt: latestTimestamp(run.lastOutputAt, run.lastInputAt, notedActivity.get(run.id)),
      },
      nowMs,
      config.idleTimeoutMs,
    )
    if (!inspection.possiblyStalled) {
      // Below the threshold again — the episode is over; a future stall re-notifies.
      stalledNotified.delete(run.id)
      return
    }
    const firstNotification = !stalledNotified.has(run.id)
    if (firstNotification) {
      stalledNotified.add(run.id)
      deps.events.emit('agent.watchdog', {
        runId: run.id,
        check: 'idle',
        silentForMs: inspection.silentForMs,
      })
      deps.events.emit('agent.stalled', {
        runId: run.id,
        silentForMs: inspection.silentForMs,
        action: config.idleAction,
      })
    }
    if (config.idleAction === 'ask') {
      // TASK-130 opens the Decision; this Task only reports (§5.3).
      return
    }
    // 'stop': keep retrying across ticks until the run leaves the active set —
    // but emit the events only once per episode (above).
    const classification: AgentFailureClassification = {
      kind: 'unknown',
      retryable: true,
      evidence: `idle for ${String(Math.floor(inspection.silentForMs / 60_000))} min`,
    }
    const stopped = await deps.agents.failAndStop(run.id, classification)
    if (!stopped.ok) {
      logger.warn(
        { runId: run.id, error: stopped.error },
        'Run watchdog failed to stop an idle run; retrying on the next tick.',
      )
    }
  }

  const inspect = async (): Promise<void> => {
    const listed = deps.runs.listActive()
    if (!listed.ok) {
      logger.error({ error: listed.error }, 'Run watchdog could not list active runs.')
      return
    }
    const nowMs = Date.now()
    const seen = new Set<string>()
    for (const run of listed.data) {
      seen.add(run.id)
      const config = deps.resolveConfig(run.workspaceId)
      if (!config.ok) {
        logger.error(
          { runId: run.id, workspaceId: run.workspaceId, error: config.error },
          'Run watchdog could not resolve the watchdog config.',
        )
        continue
      }
      await checkPreparing(run, config.data, nowMs)
      await checkIdle(run, config.data, nowMs)
    }
    // Drop bookkeeping for runs that left the active set (terminal or gone).
    for (const id of [...preparingConflicts.keys()]) {
      if (!seen.has(id)) preparingConflicts.delete(id)
    }
    for (const id of [...preparingEscalated]) {
      if (!seen.has(id)) preparingEscalated.delete(id)
    }
    for (const id of [...stalledNotified]) {
      if (!seen.has(id)) stalledNotified.delete(id)
    }
    for (const id of [...notedActivity.keys()]) {
      if (!seen.has(id)) notedActivity.delete(id)
    }
  }

  // §5.1: a tick still in flight skips the next interval fire — never queued.
  const tick = async (): Promise<void> => {
    if (disposed || ticking) return
    ticking = true
    try {
      await inspect()
    } catch (cause) {
      logger.error({ cause }, 'Run watchdog tick failed unexpectedly.')
    } finally {
      ticking = false
    }
  }

  const timer = setInterval(() => void tick(), WATCHDOG_TICK_MS)

  return {
    noteActivity,
    acknowledgeIdle(runId) {
      const timestamp = new Date().toISOString()
      const updated = deps.runs.update(runId, { lastInputAt: timestamp }, timestamp)
      if (!updated.ok) return updated
      if (updated.data === null) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Agent run "${runId}" was not found.`,
          messageKey: 'errorMessage.agentRunNotFound',
          params: { id: runId },
          retryable: false,
          detail: `acknowledgeIdle run=${runId} matched no row`,
        })
      }
      notedActivity.set(runId, timestamp)
      stalledNotified.delete(runId)
      return { ok: true, data: undefined }
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearInterval(timer)
      stopOutput()
    },
  }
}
