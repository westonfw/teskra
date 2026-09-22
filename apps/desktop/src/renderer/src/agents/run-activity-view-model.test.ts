import type { AgentObservationRecord } from '@teskra/contracts'
import { describe, expect, it } from 'vitest'

import {
  applyFeedPage,
  applyLiveRecord,
  buildActivityItems,
  defaultRunDetailTab,
  initialRunFeedState,
  mergeFeedRecords,
  nextAfterSeq,
  RUN_FEED_PAGE_SIZE,
} from './run-activity-view-model'

function observationRecord(
  seq: number,
  observation: AgentObservationRecord['observation'],
): AgentObservationRecord {
  return { seq, observation, createdAt: '2026-09-21T10:00:00.000Z' }
}

describe('mergeFeedRecords', () => {
  it('appends fresh records sorted ascending by seq', () => {
    const merged = mergeFeedRecords([{ seq: 1 }, { seq: 3 }], [{ seq: 4 }, { seq: 2 }])
    expect(merged.map((record) => record.seq)).toEqual([1, 2, 3, 4])
  })

  it('dedupes records that arrive twice (live event racing a page fetch)', () => {
    const existing = [{ seq: 1 }, { seq: 2 }]
    const merged = mergeFeedRecords(existing, [{ seq: 2 }, { seq: 3 }])
    expect(merged.map((record) => record.seq)).toEqual([1, 2, 3])
  })

  it('returns the same reference when nothing is new', () => {
    const existing = [{ seq: 1 }]
    expect(mergeFeedRecords(existing, [{ seq: 1 }])).toBe(existing)
    expect(mergeFeedRecords(existing, [])).toBe(existing)
  })
})

describe('feed paging (list-observations / list-progress afterSeq cursor)', () => {
  it('marks hasMore on a full page and clears it on a short page', () => {
    const full = Array.from({ length: RUN_FEED_PAGE_SIZE }, (_, index) => ({ seq: index + 1 }))
    const state = applyFeedPage(initialRunFeedState(), full, RUN_FEED_PAGE_SIZE)
    expect(state.hasMore).toBe(true)
    expect(nextAfterSeq(state.records)).toBe(RUN_FEED_PAGE_SIZE)

    const rest = [{ seq: RUN_FEED_PAGE_SIZE + 1 }]
    const done = applyFeedPage(state, rest, RUN_FEED_PAGE_SIZE)
    expect(done.hasMore).toBe(false)
    expect(done.records).toHaveLength(RUN_FEED_PAGE_SIZE + 1)
  })

  it('resumes strictly after the highest loaded seq', () => {
    expect(nextAfterSeq([])).toBeUndefined()
    expect(nextAfterSeq([{ seq: 7 }, { seq: 9 }])).toBe(9)
  })

  it('appends live records incrementally without re-paging and keeps the cursor', () => {
    const paged = applyFeedPage(initialRunFeedState(), [{ seq: 1 }, { seq: 2 }], RUN_FEED_PAGE_SIZE)
    const withLive = applyLiveRecord(paged, { seq: 3 })
    expect(withLive.records.map((record) => record.seq)).toEqual([1, 2, 3])
    expect(withLive.hasMore).toBe(false)

    const duplicate = applyLiveRecord(withLive, { seq: 3 })
    expect(duplicate).toBe(withLive)
  })
})

describe('buildActivityItems', () => {
  it('pairs a tool_result into the preceding tool_call', () => {
    const items = buildActivityItems([
      observationRecord(1, { kind: 'session', sessionId: 's-1' }),
      observationRecord(2, { kind: 'tool_call', toolName: 'Bash', input: '{"command":"ls"}' }),
      observationRecord(3, { kind: 'tool_result', toolName: 'Bash', ok: true, output: 'ok' }),
    ])
    expect(items).toHaveLength(2)
    const call = items[1]
    expect(call?.observation.kind).toBe('tool_call')
    expect(call?.pairedResult?.output).toBe('ok')
  })

  it('prefers the unpaired call with the same tool name', () => {
    const items = buildActivityItems([
      observationRecord(1, { kind: 'tool_call', toolName: 'Read', input: '{}' }),
      observationRecord(2, { kind: 'tool_call', toolName: 'Bash', input: '{}' }),
      observationRecord(3, { kind: 'tool_result', toolName: 'Read', ok: true, output: 'file' }),
    ])
    expect(items[0]?.pairedResult?.output).toBe('file')
    expect(items[1]?.pairedResult).toBeUndefined()
  })

  it('renders a tool_result standalone when no tool_call is pending', () => {
    const items = buildActivityItems([
      observationRecord(1, { kind: 'tool_result', ok: false, output: 'boom' }),
    ])
    expect(items).toHaveLength(1)
    expect(items[0]?.observation.kind).toBe('tool_result')
    expect(items[0]?.pairedResult).toBeUndefined()
  })

  it('keeps non-tool observations in seq order', () => {
    const items = buildActivityItems([
      observationRecord(1, { kind: 'assistant_text', text: 'hi' }),
      observationRecord(2, {
        kind: 'usage',
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
      observationRecord(3, { kind: 'result', ok: true, durationMs: 10, turns: 1 }),
    ])
    expect(items.map((item) => item.observation.kind)).toEqual([
      'assistant_text',
      'usage',
      'result',
    ])
  })
})

describe('defaultRunDetailTab', () => {
  it('lands exec runs with observations on the Activity tab', () => {
    expect(defaultRunDetailTab({ mode: 'exec' }, true)).toBe('activity')
  })

  it('keeps exec runs without observations on the raw output tab', () => {
    expect(defaultRunDetailTab({ mode: 'exec' }, false)).toBe('output')
  })

  it('never defaults interactive runs to Activity, even with observations', () => {
    expect(defaultRunDetailTab({ mode: 'interactive' }, true)).toBe('output')
    expect(defaultRunDetailTab({}, true)).toBe('output')
    expect(defaultRunDetailTab(undefined, true)).toBe('output')
  })
})
