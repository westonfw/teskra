import type { AgentRun } from '@teskra/contracts'

import { getLogger } from '../logger'
import type { HostProcessControl } from './host-processes'

/**
 * P0-2 / §19.5 — the identity-verified survivor probe/terminate shared by
 * startup reconciliation (TASK-040) and cross-profile continuation
 * (TASK-107). Extracted from ReconciliationService so both paths run ONE
 * implementation of the pid-identity judgment:
 *
 * A pid alone does not name a process: after a reboot or pid wraparound the
 * recorded number belongs to an unrelated process, and killing it (on
 * Windows `taskkill /T /F` takes the whole tree) would be an arbitrary kill.
 * Runs that carry a pid identity token (migration 011) are verified against
 * a fresh start-time read; a mismatch — or a gone pid — means the recorded
 * process is dead, without touching whatever owns the pid now. A FAILED
 * identity read (PowerShell policy-blocked, ps timeout) is neither dead nor
 * verified: reported as 'alive' so the caller leaves the run alone instead
 * of risking a double-write or an arbitrary kill. Legacy rows without a
 * token keep the probe-only behavior — except TERMINAL legacy rows, which
 * are never probed or killed (P2-12: the pid may name an unrelated process
 * by now and a recorded exit code already proves the Agent exited).
 */
export type SurvivorTermination =
  /** No survivor: no pid recorded, pid gone, or the pid now belongs to an unrelated process. */
  | 'none'
  /** The survivor was verified against its identity token and terminated. */
  | 'terminated'
  /** Still alive: identity unreadable, or termination failed — the caller must NOT proceed. */
  | 'alive'

const TERMINAL_STATUSES: readonly AgentRun['status'][] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]

export async function terminateSurvivorProcess(
  hostProcesses: HostProcessControl | undefined,
  run: Pick<AgentRun, 'id' | 'pid' | 'pidIdentity'> &
    Partial<Pick<AgentRun, 'status' | 'exitCode'>>,
): Promise<SurvivorTermination> {
  const logger = getLogger('runtime')
  if (hostProcesses === undefined || run.pid === undefined) return 'none'
  const pid = run.pid
  // P2-12 (docs/code-review-2026-09-21.md §4): a TERMINAL legacy row (no
  // identity token — every run recorded before migration 011) is never
  // probed or killed. A recorded exit code already proves the process is
  // gone, and for any other terminal row the pid may have been reused by an
  // unrelated process since — probing it tells nothing about the Agent and
  // killing it would be an arbitrary kill.
  if (
    run.pidIdentity === undefined &&
    (run.exitCode !== undefined ||
      (run.status !== undefined && TERMINAL_STATUSES.includes(run.status)))
  ) {
    return 'none'
  }
  if (run.pidIdentity !== undefined) {
    const identity = await hostProcesses.identity(pid)
    if (!identity.ok) {
      logger.warn(
        { runId: run.id, pid, error: identity.error },
        'Host pid identity read failed; the process is treated as alive rather than risking an arbitrary kill.',
      )
      return 'alive'
    }
    if (identity.data === null) return 'none'
    if (identity.data !== run.pidIdentity) {
      logger.warn(
        { runId: run.id, pid },
        'The recorded pid now belongs to an unrelated process; treating the Agent process as dead.',
      )
      return 'none'
    }
  } else {
    // Legacy rows (pre-011): probe-only liveness, as before tokens.
    const probe = await hostProcesses.probe(pid)
    if (!probe.ok) {
      logger.warn(
        { runId: run.id, pid, error: probe.error },
        'Host pid probe failed; treating the process as dead.',
      )
      return 'none'
    }
    if (!probe.data) return 'none'
  }
  const terminated = await hostProcesses.terminate(pid)
  if (terminated.ok) {
    logger.warn({ runId: run.id, pid }, 'Terminated a surviving Agent process.')
    return 'terminated'
  }
  logger.error(
    { runId: run.id, pid, error: terminated.error },
    'A surviving Agent process could not be terminated.',
  )
  return 'alive'
}
