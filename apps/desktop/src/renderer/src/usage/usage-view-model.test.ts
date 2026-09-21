import { describe, expect, it } from 'vitest'

import { enUS, type TranslationKey, type TranslationParams } from '../i18n/en-US'
import { zhCN } from '../i18n/zh-CN'
import {
  accountRecentUsageLabel,
  formatCostUsdMicros,
  formatTokenCount,
  runUsageLabel,
  sumUsageBuckets,
  usageByAgent,
  usageTotalsLabel,
} from './usage-view-model'
import type { AgentRunUsage, UsageSummaryBucket } from '@teskra/contracts'

const translate = (key: TranslationKey, params?: TranslationParams): string => {
  let text: string = enUS[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

const translateZh = (key: TranslationKey, params?: TranslationParams): string => {
  let text: string = zhCN[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

function makeUsage(partial: Partial<AgentRunUsage> = {}): AgentRunUsage {
  return {
    runId: 'run-1',
    source: 'codex-exec-json',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: 1,
    updatedAt: '2026-09-22T00:00:00.000Z',
    ...partial,
  }
}

function makeBucket(partial: Partial<UsageSummaryBucket> = {}): UsageSummaryBucket {
  return {
    workspaceId: 'ws-1',
    agentType: 'codex',
    runs: 1,
    turns: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...partial,
  }
}

describe('formatTokenCount', () => {
  it('formats small / kilo / mega counts compactly', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1_000)).toBe('1k')
    expect(formatTokenCount(1_250)).toBe('1.3k')
    expect(formatTokenCount(3_400_000)).toBe('3.4M')
  })
})

describe('formatCostUsdMicros', () => {
  it('renders undefined as "not reported", never $0', () => {
    expect(formatCostUsdMicros(undefined, translate)).toBe('Not reported')
    expect(formatCostUsdMicros(undefined, translateZh)).toBe('未报告')
  })

  it('formats sub-dollar costs with cents precision and trims trailing zeros', () => {
    expect(formatCostUsdMicros(25_000, translate)).toBe('$0.025')
    expect(formatCostUsdMicros(500_000, translate)).toBe('$0.50')
    expect(formatCostUsdMicros(1_500_000, translate)).toBe('$1.50')
    expect(formatCostUsdMicros(0, translate)).toBe('$0.00')
  })
})

describe('runUsageLabel', () => {
  it('is undefined until the run reported usage', () => {
    expect(runUsageLabel(undefined, translate)).toBeUndefined()
    expect(runUsageLabel(null, translate)).toBeUndefined()
  })

  it('shows tokens and the provider-reported cost', () => {
    const label = runUsageLabel(
      makeUsage({ inputTokens: 12_000, outputTokens: 4_500, costUsdMicros: 25_000 }),
      translate,
    )
    expect(label).toBe('12k in · 4.5k out · Cost: $0.025')
  })

  it('shows 「未报告」 when costUsdMicros is NULL', () => {
    expect(runUsageLabel(makeUsage({ inputTokens: 5 }), translateZh)).toContain('未报告')
    expect(runUsageLabel(makeUsage({ inputTokens: 5 }), translate)).toContain('Not reported')
  })
})

describe('sumUsageBuckets / usageTotalsLabel', () => {
  it('sums all four token columns and omits cost when no bucket reported one', () => {
    const totals = sumUsageBuckets([
      makeBucket({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1 }),
      makeBucket({ workspaceId: 'ws-2', inputTokens: 50 }),
    ])
    expect(totals).toEqual({ tokens: 166 })
    expect(usageTotalsLabel(totals, translate)).toBe('166 tokens')
  })

  it('sums cost over the reporting buckets only', () => {
    const totals = sumUsageBuckets([
      makeBucket({ costUsdMicros: 1_000 }),
      makeBucket({ workspaceId: 'ws-2' }),
      makeBucket({ workspaceId: 'ws-3', costUsdMicros: 500 }),
    ])
    expect(totals.costUsdMicros).toBe(1_500)
    expect(usageTotalsLabel(totals, translate)).toBe('0 tokens · $0.0015')
  })
})

describe('accountRecentUsageLabel', () => {
  it('stays quiet when both windows are empty', () => {
    expect(accountRecentUsageLabel([], [], translate)).toBeUndefined()
  })

  it('renders the 24h / 7d pair', () => {
    const label = accountRecentUsageLabel(
      [makeBucket({ inputTokens: 1_000 })],
      [makeBucket({ inputTokens: 1_000 }), makeBucket({ workspaceId: 'ws-2', outputTokens: 500 })],
      translate,
    )
    expect(label).toBe('Usage 24h: 1k tokens · 7d: 1.5k tokens')
  })
})

describe('usageByAgent', () => {
  it('groups buckets by agent and sorts by tokens descending', () => {
    const lines = usageByAgent(
      [
        makeBucket({ agentType: 'codex', inputTokens: 100 }),
        makeBucket({ agentType: 'claude', inputTokens: 5_000, costUsdMicros: 1_000_000 }),
        makeBucket({ agentType: 'codex', workspaceId: 'ws-2', outputTokens: 400 }),
      ],
      translate,
    )
    expect(lines.map((line) => line.agentType)).toEqual(['claude', 'codex'])
    expect(lines[0]?.label).toBe('5k tokens · $1.00')
    expect(lines[1]?.label).toBe('500 tokens')
  })
})
