import type { DecisionOption, DecisionSeverity, PendingDecision } from '@teskra/contracts'

import { shortDuration } from '../agents/agent-watchdog'
import { hasTranslationKey, type TranslationKey } from '../i18n'
import type { WorkbenchPage } from '../stores/navigation-store'

/**
 * TASK-131 (teskra-tasks.md; Milestone 25 design doc §9.3): the pure
 * presentation logic of the Decision Inbox — grouping, badge counts, per-kind
 * detail lines, context links and option labels. Kept component-free so the
 * grouping / count / danger-confirm rules are unit-testable without a DOM.
 */

/** Fixed group order: what blocks the user comes first. */
export const DECISION_SEVERITY_ORDER = ['blocking', 'warning', 'info'] as const

export interface DecisionGroup {
  readonly severity: DecisionSeverity
  readonly decisions: readonly PendingDecision[]
}

/** Groups open decisions by severity in DECISION_SEVERITY_ORDER; empty groups dropped. */
export function groupDecisionsBySeverity(
  decisions: readonly PendingDecision[],
): readonly DecisionGroup[] {
  const sorted = [...decisions].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return DECISION_SEVERITY_ORDER.map((severity) => ({
    severity,
    decisions: sorted.filter((decision) => decision.severity === severity),
  })).filter((group) => group.decisions.length > 0)
}

/** The navigation badge counts only still-open decisions. */
export function countOpenDecisions(decisions: readonly PendingDecision[]): number {
  return decisions.filter((decision) => decision.status === 'open').length
}

export interface DecisionContextLink {
  readonly page: WorkbenchPage
  /** Present when the link targets a specific run (opens its detail drawer). */
  readonly openRunId?: string | undefined
  readonly labelKey: TranslationKey
}

/**
 * Source-context links for an item (design doc §9.3: Run / Workflow / Worktree).
 * Run links open the run detail drawer on the Runs page; workflow runs land on
 * Tasks (workflow runs live there); worktrees land on Git.
 */
export function decisionContextLinks(decision: PendingDecision): readonly DecisionContextLink[] {
  const links: DecisionContextLink[] = []
  if (decision.runId !== undefined) {
    links.push({ page: 'runs', openRunId: decision.runId, labelKey: 'inbox.context.run' })
  }
  if (decision.workflowRunId !== undefined) {
    links.push({ page: 'tasks', labelKey: 'inbox.context.workflow' })
  }
  if (decision.worktreeId !== undefined) {
    links.push({ page: 'git', labelKey: 'inbox.context.worktree' })
  }
  return links
}

/**
 * One display line of a decision's detail payload. `code` lines render as
 * monospace blocks (the full shell command, the preserved raw path).
 */
export interface DecisionDetailLine {
  readonly text: string
  readonly code?: boolean
}

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

export function decisionDetailLines(decision: PendingDecision, t: Translate): DecisionDetailLine[] {
  const detail = decision.detail
  switch (detail.kind) {
    case 'shell_confirmation':
      return [
        { text: detail.command, code: true },
        { text: t('inbox.detail.cwd', { cwd: detail.cwd }) },
      ]
    case 'agent_blocker':
      return [{ text: detail.text }]
    case 'stalled_run':
      return [
        { text: t('inbox.detail.silentFor', { duration: shortDuration(detail.silentForMs) }) },
      ]
    case 'merge_blocked':
      return detail.blockers.map((blocker) => ({ text: `${blocker.code}: ${blocker.message}` }))
    case 'rate_limit':
      return [
        { text: detail.message },
        ...(detail.limitedUntil === undefined
          ? [{ text: t('inbox.detail.rateLimitResetUnknown') }]
          : [
              {
                text: t('inbox.detail.rateLimitResetAt', {
                  time: new Date(detail.limitedUntil).toLocaleString(),
                }),
              },
            ]),
      ]
    case 'handoff_degraded':
      return [
        { text: detail.rawPath, code: true },
        ...(detail.issues ?? []).map((issue) => ({ text: issue })),
      ]
  }
}

/**
 * Options carry English labels persisted by Main (the decision vocabulary is
 * shared with Main-side actions); known ids get a localized label, unknown ids
 * fall back to the persisted label so new options never render blank.
 */
export function decisionOptionLabel(option: DecisionOption, t: Translate): string {
  const key = `inbox.option.${option.id}`
  return hasTranslationKey(key) ? t(key) : option.label
}

/** danger options (e.g. force_merge) get a second confirmation (§9.3). */
export function decisionOptionNeedsConfirm(option: DecisionOption): boolean {
  return option.danger === true
}

/**
 * The one option whose action lives in the renderer: Main records the
 * resolution only (agent-manager.ts — continue_with_account is a no-op there),
 * the target-account pick is the TASK-108 ContinueWithAccountModal flow.
 */
export function isContinueWithAccountOption(
  decision: PendingDecision,
  option: DecisionOption,
): boolean {
  return decision.kind === 'rate_limit' && option.id === 'continue_with_account'
}
