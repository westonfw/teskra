export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

const WATCHDOG_ACTIVE_STATUSES = new Set([
  'running',
  'waiting_for_user',
  'waiting_for_permission',
  'waiting_for_agent',
  'reviewing',
])

export interface WatchdogRun {
  readonly status: string
  readonly createdAt: string
  readonly startedAt?: string
  readonly lastOutputAt?: string
}

export interface WatchdogInspection {
  readonly possiblyStalled: boolean
  readonly silentForMs: number
  readonly observedAt: string
}

/** TASK-085 pure observation only: this module has no process-control capability. */
export function inspectRunWatchdog(
  run: WatchdogRun,
  nowMs: number,
  stalledThresholdMs: number,
): WatchdogInspection {
  const observedAt = run.lastOutputAt ?? run.startedAt ?? run.createdAt
  const observedMs = Date.parse(observedAt)
  const silentForMs = Number.isFinite(observedMs) ? Math.max(0, nowMs - observedMs) : 0
  return {
    possiblyStalled:
      WATCHDOG_ACTIVE_STATUSES.has(run.status) &&
      stalledThresholdMs >= 1_000 &&
      silentForMs >= stalledThresholdMs,
    silentForMs,
    observedAt,
  }
}
