import type {
  CriteriaReviewOutcome,
  CriterionResult,
  HandoffParseStatus,
  HandoffType,
} from '@teskra/contracts'

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export * from './workflow'
export * from './review-aggregate'
export * from './routing'

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

/**
 * Structural view of a persisted handoff row (contracts `HandoffRecord`)
 * sufficient for context rendering — keeps this module usable from any
 * process without depending on the Main-side repository type.
 */
export interface HandoffContextSource {
  readonly type: HandoffType
  readonly parseStatus: HandoffParseStatus
  readonly payload?: Record<string, unknown>
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isNonEmptyString) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * TASK-051: renders a persisted WorkerHandoff as the compact text block the
 * next Agent receives — the `{{previousHandoff}}` prompt variable (TASK-079)
 * and the resume handoff summary are both fed from this. Defensive by
 * design: degraded/missing payloads are partial records, so every field is
 * probed instead of trusted. Returns undefined when there is no handoff.
 */
export function buildHandoffContext(
  handoff: HandoffContextSource | null | undefined,
): string | undefined {
  if (handoff === null || handoff === undefined) return undefined
  const payload = handoff.payload ?? {}
  const lines: string[] = []
  const summary = payload['summary']
  lines.push(
    isNonEmptyString(summary)
      ? summary
      : `Handoff (parse_status: ${handoff.parseStatus}) contains no summary.`,
  )
  const files = stringList(payload['filesChanged'])
  if (files.length > 0) lines.push(`Files changed: ${files.join(', ')}`)
  const tests = Array.isArray(payload['tests']) ? payload['tests'] : []
  const passed = tests.filter((test) => isRecord(test) && test['passed'] === true).length
  if (tests.length > 0) {
    lines.push(`Tests: ${String(passed)} passed, ${String(tests.length - passed)} failed`)
  }
  const blockers = stringList(payload['blockers'])
  if (blockers.length > 0) lines.push(`Blockers: ${blockers.join('; ')}`)
  const nextAction = payload['suggestedNextAction']
  if (isNonEmptyString(nextAction)) lines.push(`Suggested next action: ${nextAction}`)
  return lines.join('\n')
}

/**
 * TASK-054 overall review outcome (contracts `CriteriaReviewOutcome`):
 *
 * - 'fail' when any REQUIRED criterion scored 'fail' (a required failure is
 *   never outweighed);
 * - 'pass' only when every criterion scored 'pass' — an empty criteria set or
 *   any unreviewed/unverifiable criterion is NOT a pass;
 * - 'unknown' otherwise (missing scores, explicit 'unknown', or failures on
 *   optional criteria only) — the conservative middle state.
 */
export function computeCriteriaReviewOutcome(
  criteria: readonly { readonly id: string; readonly required: boolean }[],
  scores: readonly { readonly criterionId: string; readonly result: CriterionResult }[],
): CriteriaReviewOutcome {
  const byCriterion = new Map(scores.map((score) => [score.criterionId, score.result]))
  if (
    criteria.some((criterion) => criterion.required && byCriterion.get(criterion.id) === 'fail')
  ) {
    return 'fail'
  }
  if (
    criteria.length > 0 &&
    criteria.every((criterion) => byCriterion.get(criterion.id) === 'pass')
  ) {
    return 'pass'
  }
  return 'unknown'
}
