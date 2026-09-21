import { describe, expect, it } from 'vitest'

import type { PendingDecision, PendingShellConfirmation } from '@teskra/contracts'

import {
  decisionToConfirmationItem,
  mergePending,
  shellDecisionStepId,
} from './shell-confirmation-host'

function makePending(
  overrides: Partial<PendingShellConfirmation> & Pick<PendingShellConfirmation, 'stepId'>,
): PendingShellConfirmation {
  return {
    runId: 'run-1',
    nodeId: 'node-1',
    command: 'npm run pwn',
    cwd: 'C:\\repo\\demo',
    ...overrides,
  }
}

describe('mergePending (shell confirmation backlog race)', () => {
  it('appends new confirmations and dedupes ids already queued', () => {
    const queued = makePending({ stepId: 'step-1' })
    const queue = [queued]
    const merged = mergePending(
      queue,
      [makePending({ stepId: 'step-1' }), makePending({ stepId: 'step-2' })],
      new Set(),
    )
    expect(merged).toEqual([queued, makePending({ stepId: 'step-2' })])
  })

  it('returns the same queue reference when nothing is new', () => {
    const queue = [makePending({ stepId: 'step-1' })]
    expect(mergePending(queue, [makePending({ stepId: 'step-1' })], new Set())).toBe(queue)
    expect(mergePending(queue, [], new Set())).toBe(queue)
  })

  it('drops confirmations the user already answered (late listPending snapshot)', () => {
    const answered = new Set(['step-1'])
    const merged = mergePending(
      [],
      [makePending({ stepId: 'step-1' }), makePending({ stepId: 'step-2' })],
      answered,
    )
    expect(merged).toEqual([makePending({ stepId: 'step-2' })])
  })

  it('drops answered ids arriving as live events, not only backlog entries', () => {
    const answered = new Set(['step-1'])
    const merged = mergePending([], [makePending({ stepId: 'step-1' })], answered)
    expect(merged).toEqual([])
  })

  it('keeps a re-parked step once its id is no longer suppressed', () => {
    const merged = mergePending([], [makePending({ stepId: 'step-1' })], new Set())
    expect(merged).toEqual([makePending({ stepId: 'step-1' })])
  })
})

function makeDecision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: 'dec-1',
    workspaceId: 'ws-1',
    kind: 'shell_confirmation',
    status: 'open',
    severity: 'blocking',
    workflowRunId: 'run-1',
    workflowStepId: 'step-1',
    dedupeKey: 'step-1',
    title: 'Shell step "test-implement" requires confirmation',
    detail: { kind: 'shell_confirmation', command: 'npm run pwn', cwd: 'C:\\repo\\demo' },
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
    createdAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  }
}

describe('decisionToConfirmationItem (TASK-129: the host renders from the decision channel)', () => {
  it('maps an open shell_confirmation decision to the modal item', () => {
    const item = decisionToConfirmationItem(makeDecision())
    expect(item).toEqual({
      decisionId: 'dec-1',
      runId: 'run-1',
      stepId: 'step-1',
      command: 'npm run pwn',
      cwd: 'C:\\repo\\demo',
    })
  })

  it('keeps the full command line and cwd for display', () => {
    const item = decisionToConfirmationItem(
      makeDecision({
        detail: { kind: 'shell_confirmation', command: 'npm run a && npm run b', cwd: '/repo' },
      }),
    )
    expect(item?.command).toBe('npm run a && npm run b')
    expect(item?.cwd).toBe('/repo')
  })

  it('falls back to the dedupeKey when the step reference was nulled', () => {
    // ON DELETE SET NULL (ADR-0014 §6): the audit row survives its step.
    const decision = makeDecision()
    delete (decision as { workflowStepId?: string }).workflowStepId
    expect(decisionToConfirmationItem(decision)?.stepId).toBe('step-1')
    expect(shellDecisionStepId(decision)).toBe('step-1')
  })

  it('ignores other decision kinds', () => {
    const decision = makeDecision({
      kind: 'stalled_run',
      detail: { kind: 'stalled_run', silentForMs: 60_000 },
    })
    expect(decisionToConfirmationItem(decision)).toBeNull()
    expect(shellDecisionStepId(decision)).toBeNull()
  })
})
