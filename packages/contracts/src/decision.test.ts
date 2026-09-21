import { describe, expect, it } from 'vitest'

import {
  decisionDetailSchema,
  decisionOptionSchema,
  decisionResolutionSchema,
  listDecisionsRequestSchema,
  pendingDecisionSchema,
  resolveDecisionRequestSchema,
  type DecisionDetail,
  type DecisionKind,
  type PendingDecision,
} from './decision'

const AT = '2026-09-22T00:00:00.000Z'

function decisionFixture(overrides: Partial<PendingDecision> = {}): unknown {
  return {
    id: 'dec-1',
    workspaceId: 'ws-1',
    kind: 'shell_confirmation',
    status: 'open',
    severity: 'blocking',
    dedupeKey: 'shell_confirmation:step-1',
    title: 'Confirm shell step',
    detail: { kind: 'shell_confirmation', command: 'npm run build', cwd: '/repo' },
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject', danger: true },
    ],
    createdAt: AT,
    ...overrides,
  }
}

describe('decision contracts (TASK-128 / ADR-0014)', () => {
  it('validates a shell_confirmation decision with the per-kind detail union', () => {
    const parsed = pendingDecisionSchema.safeParse(decisionFixture())
    expect(parsed.success).toBe(true)
  })

  it.each<[DecisionKind, DecisionDetail]>([
    ['shell_confirmation', { kind: 'shell_confirmation', command: 'npm test', cwd: '/repo' }],
    ['agent_blocker', { kind: 'agent_blocker', text: 'Need credentials to continue.' }],
    ['stalled_run', { kind: 'stalled_run', silentForMs: 7_200_000 }],
    [
      'merge_blocked',
      {
        kind: 'merge_blocked',
        blockers: [{ code: 'worktree-clean', message: 'dirty', overridable: true }],
      },
    ],
    ['rate_limit', { kind: 'rate_limit', message: 'rate-limited', limitedUntil: AT }],
    ['handoff_degraded', { kind: 'handoff_degraded', rawPath: '/runs/r1/handoff.raw.md' }],
  ])('accepts the %s detail shape', (kind, detail) => {
    const parsed = pendingDecisionSchema.safeParse(decisionFixture({ kind, detail }))
    expect(parsed.success).toBe(true)
  })

  it('rejects a detail whose kind does not match the decision kind', () => {
    const parsed = pendingDecisionSchema.safeParse(
      decisionFixture({ detail: { kind: 'agent_blocker', text: 'mismatch' } }),
    )
    expect(parsed.success).toBe(false)
    // The detail union itself is well-formed; the cross-field guard rejects it.
    expect(
      decisionDetailSchema.safeParse({ kind: 'agent_blocker', text: 'mismatch' }).success,
    ).toBe(true)
  })

  it('rejects an unknown detail kind in the discriminated union', () => {
    expect(decisionDetailSchema.safeParse({ kind: 'remember_me' }).success).toBe(false)
  })

  it('has no "remember my choice" option field — strictObject rejects one (ADR-0014 §7)', () => {
    const parsed = decisionOptionSchema.safeParse({
      id: 'approve',
      label: 'Approve',
      remember: true,
    })
    expect(parsed.success).toBe(false)
  })

  it('resolution decidedBy covers user / timeout / system and nothing else', () => {
    for (const decidedBy of ['user', 'timeout', 'system'] as const) {
      expect(
        decisionResolutionSchema.safeParse({ optionId: 'approve', decidedBy, decidedAt: AT })
          .success,
      ).toBe(true)
    }
    expect(
      decisionResolutionSchema.safeParse({ optionId: 'approve', decidedBy: 'agent', decidedAt: AT })
        .success,
    ).toBe(false)
  })

  it('IPC requests are strictObject and list filters are all optional', () => {
    expect(listDecisionsRequestSchema.safeParse({}).success).toBe(true)
    expect(
      listDecisionsRequestSchema.safeParse({
        workspaceId: 'ws-1',
        kind: 'stalled_run',
        status: 'open',
      }).success,
    ).toBe(true)
    expect(listDecisionsRequestSchema.safeParse({ runId: 'run-1' }).success).toBe(false)
    expect(
      resolveDecisionRequestSchema.safeParse({ id: 'dec-1', optionId: 'approve' }).success,
    ).toBe(true)
    expect(
      resolveDecisionRequestSchema.safeParse({ id: 'dec-1', optionId: 'approve', force: true })
        .success,
    ).toBe(false)
  })
})
