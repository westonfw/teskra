import { describe, expect, it } from 'vitest'

import { inspectRunWatchdog, isNonEmptyString } from './index'

describe('isNonEmptyString', () => {
  it('accepts a non-empty string', () => {
    expect(isNonEmptyString('teskra')).toBe(true)
  })

  it('rejects empty strings and non-strings', () => {
    expect(isNonEmptyString('')).toBe(false)
    expect(isNonEmptyString(undefined)).toBe(false)
    expect(isNonEmptyString(42)).toBe(false)
  })
})

describe('inspectRunWatchdog (TASK-085)', () => {
  const run = {
    status: 'running',
    createdAt: '2026-09-10T00:00:00.000Z',
    startedAt: '2026-09-10T00:01:00.000Z',
    lastOutputAt: '2026-09-10T00:02:00.000Z',
  }

  it('marks a silent active Run only after its configured threshold', () => {
    expect(inspectRunWatchdog(run, Date.parse('2026-09-10T00:11:59.999Z'), 600_000)).toMatchObject({
      possiblyStalled: false,
      silentForMs: 599_999,
    })
    expect(inspectRunWatchdog(run, Date.parse('2026-09-10T00:12:00.000Z'), 600_000)).toMatchObject({
      possiblyStalled: true,
      silentForMs: 600_000,
    })
  })

  it('never labels terminal or queued Runs stalled regardless of age', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'interrupted', 'queued']) {
      expect(
        inspectRunWatchdog({ ...run, status }, Date.parse('2026-09-11T00:00:00.000Z'), 1_000)
          .possiblyStalled,
      ).toBe(false)
    }
  })

  it('allows the Fake Agent hang scenario to become possibly stalled', () => {
    const hangingFakeRun = {
      status: 'running',
      createdAt: '2026-09-10T00:00:00.000Z',
      startedAt: '2026-09-10T00:00:01.000Z',
      lastOutputAt: '2026-09-10T00:00:02.000Z',
    }
    expect(
      inspectRunWatchdog(hangingFakeRun, Date.parse('2026-09-10T00:10:02.000Z'), 600_000)
        .possiblyStalled,
    ).toBe(true)
  })
})
