import { describe, expect, it } from 'vitest'

import { buildHandoffContext, inspectRunWatchdog, isNonEmptyString } from './index'

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

describe('buildHandoffContext (TASK-051)', () => {
  it('returns undefined when a run has no handoff', () => {
    expect(buildHandoffContext(undefined)).toBeUndefined()
    expect(buildHandoffContext(null)).toBeUndefined()
  })

  it('renders a full WorkerHandoff payload as a compact context block', () => {
    const context = buildHandoffContext({
      type: 'implementation',
      parseStatus: 'ok',
      payload: {
        summary: 'Implemented the parser.',
        filesChanged: ['src/parser.ts', 'src/lexer.ts'],
        tests: [
          { name: 'parses', passed: true },
          { name: 'rejects bad input', passed: false },
        ],
        blockers: ['unicode edge cases undecided'],
        suggestedNextAction: 'Review the parser diff.',
      },
    })

    expect(context).toBe(
      [
        'Implemented the parser.',
        'Files changed: src/parser.ts, src/lexer.ts',
        'Tests: 1 passed, 1 failed',
        'Blockers: unicode edge cases undecided',
        'Suggested next action: Review the parser diff.',
      ].join('\n'),
    )
  })

  it('renders partial degraded/missing payloads defensively', () => {
    expect(
      buildHandoffContext({
        type: 'analysis',
        parseStatus: 'missing',
        payload: { source: 'terminal.log', summary: 'tail of the run output' },
      }),
    ).toBe('tail of the run output')
    expect(
      buildHandoffContext({ type: 'analysis', parseStatus: 'degraded', payload: { summary: 42 } }),
    ).toBe('Handoff (parse_status: degraded) contains no summary.')
    expect(buildHandoffContext({ type: 'review', parseStatus: 'degraded' })).toBe(
      'Handoff (parse_status: degraded) contains no summary.',
    )
  })
})
