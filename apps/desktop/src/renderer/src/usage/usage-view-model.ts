import type { AgentRunUsage, UsageSummaryBucket } from '@teskra/contracts'

import type { TranslationKey, TranslationParams } from '../i18n'

/**
 * TASK-124 (Milestone 25 §7): presentation logic for usage accounting. Pure
 * functions only — the Run detail header, account cards and the Dashboard
 * usage card all format through here so the "not reported" cost semantics
 * (NULL → 未报告, never 0) live in exactly one place.
 */

type Translate = (key: TranslationKey, params?: TranslationParams) => string

export interface UsageTotals {
  /** input + output + cache read + cache write tokens. */
  readonly tokens: number
  /** Summed over reporting runs only; undefined = nobody reported a cost. */
  readonly costUsdMicros?: number | undefined
}

/** Compact token counts: 999 → "999", 1_200 → "1.2k", 3_400_000 → "3.4M". */
export function formatTokenCount(value: number): string {
  const compact = (scaled: number, suffix: string): string => {
    const rounded = Math.round(scaled * 10) / 10
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${suffix}`
  }
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return compact(value / 1_000, 'k')
  return compact(value / 1_000_000, 'M')
}

/**
 * Provider-reported cost in USD micros → "$0.025" style text. `undefined`
 * means the provider never reported a cost and renders as 「未报告」 — never
 * as $0 (TASK-124 acceptance).
 */
export function formatCostUsdMicros(micros: number | undefined, t: Translate): string {
  if (micros === undefined) return t('usage.cost.notReported')
  const dollars = micros / 1_000_000
  if (dollars >= 1) return `$${dollars.toFixed(2)}`
  // 4 decimals, trailing zeros trimmed, but never fewer than 2 ("$0.50").
  const trimmed = dollars.toFixed(4).replace(/(\.\d*?)0+$/, '$1')
  const decimals = trimmed.split('.')[1] ?? ''
  return `$${trimmed}${'0'.repeat(Math.max(0, 2 - decimals.length))}`
}

/** The one-line summary for the Run detail header; undefined = no usage yet. */
export function runUsageLabel(
  usage: AgentRunUsage | null | undefined,
  t: Translate,
): string | undefined {
  if (usage === undefined || usage === null) return undefined
  return t('usage.run.summary', {
    input: formatTokenCount(usage.inputTokens),
    output: formatTokenCount(usage.outputTokens),
    cost: formatCostUsdMicros(usage.costUsdMicros, t),
  })
}

/** Sums summary buckets (already scoped by the IPC filter) into one total. */
export function sumUsageBuckets(buckets: readonly UsageSummaryBucket[]): UsageTotals {
  let tokens = 0
  let costUsdMicros: number | undefined
  for (const bucket of buckets) {
    tokens +=
      bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens
    if (bucket.costUsdMicros !== undefined) {
      costUsdMicros = (costUsdMicros ?? 0) + bucket.costUsdMicros
    }
  }
  return costUsdMicros === undefined ? { tokens } : { tokens, costUsdMicros }
}

/** Compact bucket text; the cost segment only appears when reported. */
export function usageTotalsLabel(totals: UsageTotals, t: Translate): string {
  const tokens = formatTokenCount(totals.tokens)
  if (totals.costUsdMicros === undefined) {
    return t('usage.bucket.compact', { tokens })
  }
  return t('usage.bucket.withCost', { tokens, cost: formatCostUsdMicros(totals.costUsdMicros, t) })
}

/**
 * The account card's "last 24h / 7d" line. Returns undefined when both windows
 * are empty so the card stays quiet (same discipline as the rate-limit stats).
 */
export function accountRecentUsageLabel(
  dayBuckets: readonly UsageSummaryBucket[],
  weekBuckets: readonly UsageSummaryBucket[],
  t: Translate,
): string | undefined {
  if (dayBuckets.length === 0 && weekBuckets.length === 0) return undefined
  return t('accounts.usage.recent', {
    day: usageTotalsLabel(sumUsageBuckets(dayBuckets), t),
    week: usageTotalsLabel(sumUsageBuckets(weekBuckets), t),
  })
}

export interface AgentUsageLine {
  readonly agentType: string
  readonly label: string
}

/** Dashboard usage card: buckets regrouped by agent, most tokens first. */
export function usageByAgent(
  buckets: readonly UsageSummaryBucket[],
  t: Translate,
): readonly AgentUsageLine[] {
  const grouped = new Map<string, UsageSummaryBucket[]>()
  for (const bucket of buckets) {
    const group = grouped.get(bucket.agentType) ?? []
    group.push(bucket)
    grouped.set(bucket.agentType, group)
  }
  return [...grouped.entries()]
    .map(([agentType, group]) => ({
      agentType,
      totals: sumUsageBuckets(group),
    }))
    .sort((left, right) => right.totals.tokens - left.totals.tokens)
    .map(({ agentType, totals }) => ({ agentType, label: usageTotalsLabel(totals, t) }))
}
