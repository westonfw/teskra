import { describe, expect, it } from 'vitest'

import { workerHandoffSchema } from './handoff'

describe('WorkerHandoff schema (plan §125 / TASK-051 / ADR-0004)', () => {
  it('accepts the §125 example payload (plus runId)', () => {
    const result = workerHandoffSchema.safeParse({
      runId: 'RUN-003',
      type: 'implementation',
      summary: 'Implemented rate-history endpoint and service.',
      filesChanged: ['RateHistoryController.cs', 'RateHistoryService.cs'],
      commandsRun: [{ command: 'dotnet test', exitCode: 0 }],
      suggestedNextAction: 'Run independent code review.',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a full payload with tests / findings / blockers', () => {
    const result = workerHandoffSchema.safeParse({
      runId: 'RUN-004',
      type: 'review',
      summary: 'Reviewed the implementation.',
      tests: [{ name: 'rate-history.spec', passed: true }],
      findings: [{ severity: 'high', title: 'Missing index', file: 'db.ts', line: 12 }],
      blockers: [],
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing runId / unknown type / extra keys (strict)', () => {
    expect(workerHandoffSchema.safeParse({ type: 'implementation', summary: 'x' }).success).toBe(
      false,
    )
    expect(workerHandoffSchema.safeParse({ runId: 'r', type: 'chat', summary: 'x' }).success).toBe(
      false,
    )
    expect(
      workerHandoffSchema.safeParse({
        runId: 'r',
        type: 'analysis',
        summary: 'x',
        unexpected: true,
      }).success,
    ).toBe(false)
  })
})
