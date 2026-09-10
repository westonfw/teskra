import type {
  CriterionScoreRecord,
  PublicAppError,
  ReviewFindingRecord,
  WorkbenchEvents,
} from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import {
  createReviewStore,
  latestScoresByCriterion,
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

function makeScore(
  overrides: Partial<CriterionScoreRecord> & Pick<CriterionScoreRecord, 'id' | 'criterionId' | 'result'>,
): CriterionScoreRecord {
  return {
    runId: 'run-1',
    createdAt: AT,
    ...overrides,
  }
}

function setup(initial: ReviewFindingRecord[] = [], initialScores: CriterionScoreRecord[] = []) {
  const findings = [...initial]
  const scores = [...initialScores]
  const handlers = new Map<string, Set<(payload: { runId: string }) => void>>()
  const bridge: ReviewStoreBridge = {
    review: {
      listFindings: vi.fn(async () => ({ ok: true as const, data: [...findings] })),
      listCriterionScores: vi.fn(async () => ({ ok: true as const, data: [...scores] })),
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
  const emit = (
    name: 'agent.completed' | 'agent.failed' | 'agent.cancelled' | 'task.updated',
    id: string,
  ) => {
    const payload =
      name === 'task.updated'
        ? { taskId: id }
        : name === 'agent.completed'
          ? { runId: id, exitCode: 0 }
          : name === 'agent.failed'
            ? {
                runId: id,
                error: { code: 'UNKNOWN', message: 'x', retryable: true } satisfies PublicAppError,
              }
            : { runId: id }
    for (const handler of handlers.get(name) ?? []) {
      handler(payload as WorkbenchEvents['agent.completed'])
    }
  }
  return { bridge, findings, scores, emit, store: createReviewStore(() => bridge) }
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
      error: { code: 'UNKNOWN', message: 'boom', retryable: true } satisfies PublicAppError,
    }))
    const stop = store.getState().startSynchronization('run-1')
    await vi.waitFor(() => expect(store.getState().loading).toBe(false))
    expect(store.getState().error?.message).toBe('boom')
    store.getState().clearError()
    expect(store.getState().error).toBeUndefined()
    stop()
  })
})

describe('latestScoresByCriterion (TASK-054)', () => {
  it('keeps the newest score per criterion', () => {
    const latest = latestScoresByCriterion([
      makeScore({ id: 's-1', criterionId: 'c-1', result: 'fail' }),
      makeScore({
        id: 's-2',
        criterionId: 'c-1',
        result: 'pass',
        createdAt: '2026-09-10T00:05:00.000Z',
      }),
      makeScore({ id: 's-3', criterionId: 'c-2', result: 'unknown' }),
    ])
    expect(latest.get('c-1')?.result).toBe('pass')
    expect(latest.get('c-2')?.result).toBe('unknown')
  })
})

describe('ReviewStore criterion scores (TASK-054)', () => {
  it('loads scores for a task and refreshes on terminal run and task events', async () => {
    const { bridge, scores, emit, store } = setup([], [
      makeScore({ id: 's-1', criterionId: 'c-1', result: 'unknown' }),
    ])
    const stop = store.getState().startScoreSynchronization('task-1')
    await vi.waitFor(() =>
      expect(store.getState().scores.map((score) => score.id)).toEqual(['s-1']),
    )

    scores.push(
      makeScore({
        id: 's-2',
        criterionId: 'c-1',
        result: 'pass',
        createdAt: '2026-09-10T00:05:00.000Z',
      }),
    )
    emit('task.updated', 'task-1')
    await vi.waitFor(() => expect(bridge.review.listCriterionScores).toHaveBeenCalledTimes(2))
    emit('agent.completed', 'run-9')
    await vi.waitFor(() => expect(bridge.review.listCriterionScores).toHaveBeenCalledTimes(3))
    expect(store.getState().scores).toHaveLength(2)
    stop()
  })
})
