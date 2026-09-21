import { describe, expect, it } from 'vitest'

import { ipcChannelDefinitions, IPC_CHANNELS } from './ipc'
import { agentRunUsageSchema, summarizeUsageRequestSchema, usageSummaryBucketSchema } from './usage'

describe('usage contracts (TASK-124)', () => {
  it('accepts a fully populated usage row', () => {
    const parsed = agentRunUsageSchema.safeParse({
      runId: 'run-1',
      source: 'claude-stream-json',
      model: 'claude-sonnet',
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 400,
      cacheWriteTokens: 50,
      costUsdMicros: 25000,
      turns: 1,
      updatedAt: '2026-09-22T00:00:00.000Z',
    })
    expect(parsed.success).toBe(true)
  })

  it('costUsdMicros is optional — absence means "not reported", never zero', () => {
    const parsed = agentRunUsageSchema.safeParse({
      runId: 'run-1',
      source: 'codex-exec-json',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 3,
      updatedAt: '2026-09-22T00:00:00.000Z',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.costUsdMicros).toBeUndefined()
    }
  })

  it('rejects negative token counts', () => {
    const parsed = agentRunUsageSchema.safeParse({
      runId: 'run-1',
      source: 'codex-exec-json',
      inputTokens: -1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 0,
      updatedAt: '2026-09-22T00:00:00.000Z',
    })
    expect(parsed.success).toBe(false)
  })

  it('summary request requires `since` and rejects unknown keys (strictObject)', () => {
    expect(
      summarizeUsageRequestSchema.safeParse({ since: '2026-09-15T00:00:00.000Z' }).success,
    ).toBe(true)
    expect(summarizeUsageRequestSchema.safeParse({}).success).toBe(false)
    expect(
      summarizeUsageRequestSchema.safeParse({
        since: '2026-09-15T00:00:00.000Z',
        pricePerToken: 1,
      }).success,
    ).toBe(false)
    expect(
      summarizeUsageRequestSchema.safeParse({
        workspaceId: 'ws-1',
        accountProfileId: 'profile-1',
        agentType: 'codex',
        since: '2026-09-15T00:00:00.000Z',
      }).success,
    ).toBe(true)
  })

  it('summary buckets carry the joined dimensions without a duplicated cost default', () => {
    const parsed = usageSummaryBucketSchema.safeParse({
      workspaceId: 'ws-1',
      agentType: 'claude',
      runs: 2,
      turns: 5,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.accountProfileId).toBeUndefined()
      expect(parsed.data.costUsdMicros).toBeUndefined()
    }
  })

  it('registers the usage IPC channels with request/response schemas', () => {
    expect(IPC_CHANNELS.usageSummary).toBe('teskra:usage:summary')
    expect(IPC_CHANNELS.usageGetByRun).toBe('teskra:usage:get-by-run')
    expect(ipcChannelDefinitions.usageSummary.channel).toBe('teskra:usage:summary')
    expect(ipcChannelDefinitions.usageGetByRun.channel).toBe('teskra:usage:get-by-run')
  })
})
