import { describe, expect, it } from 'vitest'

import type { AgentUsageObservation, WorkbenchEvents } from '@teskra/contracts'

import { createEventBus } from '../events/event-bus'
import type { AddUsageInput, UsageRepository } from '../db/repositories/usage-repository'
import { createUsageTracker } from './usage-tracker'

function makeUsage(partial: Partial<AgentUsageObservation> = {}): AgentUsageObservation {
  return {
    kind: 'usage',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    ...partial,
  }
}

describe('UsageTracker (TASK-124)', () => {
  it('accumulates each usage observation and emits usage.updated with the new row', () => {
    const events = createEventBus()
    const calls: AddUsageInput[] = []
    const usage: Pick<UsageRepository, 'upsertAdd'> = {
      upsertAdd: (input) => {
        calls.push(input)
        return {
          ok: true,
          data: {
            runId: input.runId,
            source: input.source,
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            cacheReadTokens: input.cacheReadTokens,
            cacheWriteTokens: input.cacheWriteTokens,
            turns: calls.length,
            updatedAt: '2026-09-22T00:00:00.000Z',
          },
        }
      },
    }
    const tracker = createUsageTracker({ usage, events })
    const seen: WorkbenchEvents['usage.updated'][] = []
    events.subscribe('usage.updated', (payload) => seen.push(payload))

    tracker.record('run-1', makeUsage(), 'codex-exec-json')
    tracker.record(
      'run-1',
      makeUsage({ costUsdMicros: 700, model: 'gpt-5-codex' }),
      'codex-exec-json',
    )

    expect(calls).toHaveLength(2)
    // Optional fields are omitted (never written as undefined) so the
    // repository's NULL-safe upsert can tell "not reported" from "reported".
    expect(calls[0]).not.toHaveProperty('costUsdMicros')
    expect(calls[0]).not.toHaveProperty('model')
    expect(calls[1]).toMatchObject({ costUsdMicros: 700, model: 'gpt-5-codex' })

    expect(seen).toHaveLength(2)
    expect(seen[1]?.runId).toBe('run-1')
    expect(seen[1]?.usage.turns).toBe(2)
  })

  it('swallows persistence failures (observation-only) without emitting', () => {
    const events = createEventBus()
    const usage: Pick<UsageRepository, 'upsertAdd'> = {
      upsertAdd: () => ({
        ok: false,
        error: { code: 'UNKNOWN', message: 'boom', retryable: false },
      }),
    }
    const tracker = createUsageTracker({ usage, events })
    const seen: WorkbenchEvents['usage.updated'][] = []
    events.subscribe('usage.updated', (payload) => seen.push(payload))

    expect(() => tracker.record('run-1', makeUsage(), 'claude-stream-json')).not.toThrow()
    expect(seen).toHaveLength(0)
  })
})
