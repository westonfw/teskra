import { describe, expect, it } from 'vitest'

import type { ThreadItem } from '@teskra/contracts'

import { mergeThreadItems, reconcileThreadItems } from './task-thread-view-model'

const T0 = '2026-09-23T00:00:00.000Z'
const T1 = '2026-09-23T00:01:00.000Z'
const T2 = '2026-09-23T00:02:00.000Z'

function userMessage(id: string, runId: string, createdAt: string, text = 'hi'): ThreadItem {
  return { kind: 'user_message', id, runId, createdAt, text }
}

describe('mergeThreadItems (TASK-140)', () => {
  it('appends new items in stable (createdAt, id) order', () => {
    const existing = [userMessage('user:run-b', 'run-b', T1)]
    const merged = mergeThreadItems(existing, [
      userMessage('user:run-c', 'run-c', T2),
      userMessage('user:run-a', 'run-a', T0),
    ])
    expect(merged.map((item) => item.id)).toEqual(['user:run-a', 'user:run-b', 'user:run-c'])
  })

  it('replaces a changed item in place (resolved decision keeps its slot)', () => {
    const open: ThreadItem = {
      kind: 'decision',
      id: 'decision:d1',
      decisionId: 'd1',
      createdAt: T1,
      decisionKind: 'agent_blocker',
      severity: 'info',
      status: 'open',
      title: 'Continue?',
      options: [{ id: 'acknowledge', label: 'Acknowledge' }],
    }
    const resolved: ThreadItem = {
      ...open,
      status: 'resolved',
      resolution: { optionId: 'acknowledge', decidedBy: 'user', decidedAt: T2 },
    }
    const existing = [userMessage('user:run-a', 'run-a', T0), open]
    const merged = mergeThreadItems(existing, [resolved])
    expect(merged.map((item) => item.id)).toEqual(['user:run-a', 'decision:d1'])
    expect(merged[1]).toMatchObject({ status: 'resolved' })
  })

  it('returns the original reference when nothing changed', () => {
    const existing = [userMessage('user:run-a', 'run-a', T0)]
    expect(mergeThreadItems(existing, [userMessage('user:run-a', 'run-a', T0)])).toBe(existing)
    expect(mergeThreadItems(existing, [])).toBe(existing)
  })
})

describe('reconcileThreadItems (TASK-140)', () => {
  it('prunes items the projection no longer returns', () => {
    const existing = [
      userMessage('user:run-a', 'run-a', T0),
      userMessage('user:run-b', 'run-b', T1),
    ]
    const reconciled = reconcileThreadItems(existing, [userMessage('user:run-b', 'run-b', T1)])
    expect(reconciled.map((item) => item.id)).toEqual(['user:run-b'])
  })
})
