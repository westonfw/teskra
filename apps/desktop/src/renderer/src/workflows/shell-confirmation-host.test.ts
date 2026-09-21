import { describe, expect, it } from 'vitest'

import type { PendingShellConfirmation } from '@teskra/contracts'

import { mergePending } from './shell-confirmation-host'

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
