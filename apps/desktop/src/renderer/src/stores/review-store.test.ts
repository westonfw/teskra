import type {
  PublicAppError,
  ReviewFindingRecord,
  WorkbenchEvents,
} from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import {
  createReviewStore,
  sortFindingsBySeverity,
  type ReviewStoreBridge,
} from './review-store'

const AT = '2026-09-10T00:00:00.000Z'

function makeFinding(
  overrides: Partial<ReviewFindingRecord> & Pick<ReviewFindingRecord, 'id' | 'severity' | 'title'>,
): ReviewFindingRecord {
  return {
    runId: 'run-1',
    createdAt: AT,
    ...overrides,
  }
}

function setup(initial: ReviewFindingRecord[] = []) {
  const findings = [...initial]
  const handlers = new Map<string, Set<(payload: { runId: string }) => void>>()
  const bridge: ReviewStoreBridge = {
    review: {
      listFindings: vi.fn(async () => ({ ok: true as const, data: [...findings] })),
    },
    events: {
      subscribe: (name, handler) => {
        const registered = handlers.get(name) ?? new Set()
        registered.add(handler as (payload: { runId: string }) => void)
        handlers.set(name, registered)
        return () => registered.delete(handler as (payload: { runId: string }) => void)
      },
    },
  }
  const emit = (name: 'agent.completed' | 'agent.failed' | 'agent.cancelled', runId: string) => {
    const payload =
      name === 'agent.completed'
        ? { runId, exitCode: 0 }
        : name === 'agent.failed'
          ? {
              runId,
              error: { code: 'UNKNOWN', message: 'x', retryable: true } satisfies PublicAppError,
            }
          : { runId }
    for (const handler of handlers.get(name) ?? []) {
      handler(payload as WorkbenchEvents['agent.completed'])
    }
  }
  return { bridge, findings, emit, store: createReviewStore(() => bridge) }
}

describe('sortFindingsBySeverity', () => {
  it('orders critical → high → medium → low, stable by creation time', () => {
    const sorted = sortFindingsBySeverity([
      makeFinding({ id: 'f-low', severity: 'low', title: 'l' }),
      makeFinding({ id: 'f-critical', severity: 'critical', title: 'c' }),
      makeFinding({
        id: 'f-high',
        severity: 'high',
        title: 'h',
        createdAt: '2026-09-10T00:01:00.000Z',
      }),
      makeFinding({ id: 'f-high-first', severity: 'high', title: 'h1' }),
    ])
    expect(sorted.map((finding) => finding.id)).toEqual([
      'f-critical',
      'f-high-first',
      'f-high',
      'f-low',
    ])
  })
})

describe('ReviewStore (TASK-053)', () => {
  it('loads findings for a run', async () => {
    const { store } = setup([makeFinding({ id: 'f-1', severity: 'medium', title: 'm' })])
    const stop = store.getState().startSynchronization('run-1')
    await vi.waitFor(() => expect(store.getState().loading).toBe(false))
    expect(store.getState().findings.map((finding) => finding.id)).toEqual(['f-1'])
    stop()
  })

  it('refreshes when the run terminates and ignores other runs', async () => {
    const { bridge, findings, emit, store } = setup([])
    const stop = store.getState().startSynchronization('run-1')
    await vi.waitFor(() => expect(store.getState().loading).toBe(false))

    emit('agent.completed', 'run-2')
    await vi.waitFor(() => expect(bridge.review.listFindings).toHaveBeenCalledTimes(1))

    findings.push(makeFinding({ id: 'f-late', severity: 'critical', title: 'late' }))
    emit('agent.completed', 'run-1')
    await vi.waitFor(() =>
      expect(store.getState().findings.map((finding) => finding.id)).toEqual(['f-late']),
    )
    stop()
  })

  it('surfaces transport and service errors', async () => {
    const { bridge, store } = setup([])
    bridge.review.listFindings = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'UNKNOWN', message: 'boom', retryable: true },
    }))
    const stop = store.getState().startSynchronization('run-1')
    await vi.waitFor(() => expect(store.getState().loading).toBe(false))
    expect(store.getState().error?.message).toBe('boom')
    store.getState().clearError()
    expect(store.getState().error).toBeUndefined()
    stop()
  })
})
