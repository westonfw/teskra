import type {
  AcceptanceCriteriaSet,
  AcceptanceCriteriaSetDetail,
  AcceptanceCriterion,
  PublicAppError,
  WorkbenchEvents,
} from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import {
  createCriteriaStore,
  editableCriteriaDetail,
  isCriteriaSetEditable,
  sortCriteriaDetails,
  type CriteriaStoreBridge,
} from './criteria-store'

let idCounter = 0

function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${idCounter}`
}

function makeSet(overrides: Partial<AcceptanceCriteriaSet> = {}): AcceptanceCriteriaSet {
  return {
    id: nextId('set'),
    taskId: 'task-1',
    version: 1,
    status: 'draft',
    createdAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

function makeCriterion(
  criteriaSetId: string,
  ordinal: number,
  overrides: Partial<AcceptanceCriterion> = {},
): AcceptanceCriterion {
  return {
    id: nextId('criterion'),
    criteriaSetId,
    ordinal,
    description: `Criterion ${ordinal}`,
    required: true,
    createdAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

const rejected: PublicAppError = {
  code: 'VALIDATION_FAILED',
  message: 'Only draft criteria sets can be changed.',
  retryable: false,
}

/**
 * In-memory double mirroring the TASK-048 state machine: only draft sets are
 * mutable, confirming requires at least one criterion and supersedes every
 * other confirmed set of the same Task.
 */
function setup(initial: { sets?: AcceptanceCriteriaSet[]; criteria?: AcceptanceCriterion[] } = {}) {
  const sets = [...(initial.sets ?? [])]
  let criteria = [...(initial.criteria ?? [])]
  const handlers = new Set<(payload: WorkbenchEvents['task.updated']) => void>()

  const detail = (set: AcceptanceCriteriaSet): AcceptanceCriteriaSetDetail => ({
    set,
    criteria: criteria
      .filter(({ criteriaSetId }) => criteriaSetId === set.id)
      .sort((left, right) => left.ordinal - right.ordinal),
  })

  const requireDraft = (setId: string) => {
    const set = sets.find(({ id }) => id === setId)
    if (set === undefined || set.status !== 'draft') return { ok: false as const, error: rejected }
    return { ok: true as const, data: set }
  }

  const bridge: CriteriaStoreBridge = {
    criteria: {
      listSets: vi.fn(async ({ taskId }) => ({
        ok: true as const,
        data: sets.filter((set) => set.taskId === taskId),
      })),
      getSet: vi.fn(async ({ setId }) => {
        const set = sets.find(({ id }) => id === setId)
        return { ok: true as const, data: set === undefined ? null : detail(set) }
      }),
      createSet: vi.fn(async ({ taskId }) => {
        const version = Math.max(0, ...sets.map((set) => set.version)) + 1
        const set = makeSet({ taskId, version })
        sets.push(set)
        return { ok: true as const, data: detail(set) }
      }),
      addCriterion: vi.fn(async (request) => {
        const set = requireDraft(request.setId)
        if (!set.ok) return set
        const ordinal =
          criteria.reduce(
            (max, criterion) =>
              criterion.criteriaSetId === request.setId
                ? Math.max(max, criterion.ordinal)
                : max,
            0,
          ) + 1
        const criterion = makeCriterion(request.setId, ordinal, {
          description: request.description,
          ...(request.category === undefined ? {} : { category: request.category }),
          required: request.required ?? true,
        })
        criteria.push(criterion)
        return { ok: true as const, data: criterion }
      }),
      updateCriterion: vi.fn(async (request) => {
        const criterion = criteria.find(({ id }) => id === request.criterionId)
        const set = criterion === undefined ? { ok: false as const, error: rejected } : requireDraft(criterion.criteriaSetId)
        if (!set.ok || criterion === undefined) return { ok: false as const, error: rejected }
        const updated: AcceptanceCriterion = {
          ...criterion,
          ...(request.description === undefined ? {} : { description: request.description }),
          ...(request.category === undefined
            ? {}
            : request.category === null
              ? { category: undefined }
              : { category: request.category }),
          ...(request.required === undefined ? {} : { required: request.required }),
          ...(request.ordinal === undefined ? {} : { ordinal: request.ordinal }),
        }
        criteria = criteria.map((item) => (item.id === updated.id ? updated : item))
        return { ok: true as const, data: updated }
      }),
      removeCriterion: vi.fn(async ({ criterionId }) => {
        const criterion = criteria.find(({ id }) => id === criterionId)
        if (criterion === undefined) return { ok: true as const, data: false }
        const set = requireDraft(criterion.criteriaSetId)
        if (!set.ok) return set
        criteria = criteria.filter(({ id }) => id !== criterionId)
        return { ok: true as const, data: true }
      }),
      confirmSet: vi.fn(async ({ setId }) => {
        const set = requireDraft(setId)
        if (!set.ok) return set
        if (!criteria.some(({ criteriaSetId }) => criteriaSetId === setId)) {
          return { ok: false as const, error: rejected }
        }
        for (const other of sets) {
          if (other.taskId === set.data.taskId && other.status === 'confirmed') {
            other.status = 'superseded'
          }
        }
        set.data.status = 'confirmed'
        set.data.confirmedAt = '2026-09-10T01:00:00.000Z'
        return { ok: true as const, data: { ...set.data } }
      }),
    },
    events: {
      subscribe: vi.fn((_name, handler) => {
        handlers.add(handler as (payload: WorkbenchEvents['task.updated']) => void)
        return () =>
          handlers.delete(handler as (payload: WorkbenchEvents['task.updated']) => void)
      }),
    },
  }

  return {
    bridge,
    emit(taskId: string) {
      for (const handler of handlers) handler({ taskId })
    },
  }
}

describe('Criteria store helpers', () => {
  it('sorts versions newest first and finds the editable draft', () => {
    const old: AcceptanceCriteriaSetDetail = {
      set: makeSet({ version: 1, status: 'superseded' }),
      criteria: [],
    }
    const draft: AcceptanceCriteriaSetDetail = { set: makeSet({ version: 2 }), criteria: [] }
    const sorted = sortCriteriaDetails([old, draft])
    expect(sorted.map(({ set }) => set.version)).toEqual([2, 1])
    expect(editableCriteriaDetail([old, draft])?.set.id).toBe(draft.set.id)
    expect(editableCriteriaDetail([old])).toBeUndefined()
    expect(isCriteriaSetEditable(draft.set)).toBe(true)
    expect(isCriteriaSetEditable({ ...draft.set, status: 'confirmed' })).toBe(false)
  })
})

describe('Criteria store', () => {
  it('synchronizes all versions of a Task, newest first', async () => {
    const confirmed = makeSet({ version: 1, status: 'confirmed' })
    const draft = makeSet({ version: 2 })
    const context = setup({
      sets: [confirmed, draft],
      criteria: [makeCriterion(confirmed.id, 1), makeCriterion(draft.id, 1)],
    })
    const store = createCriteriaStore(() => context.bridge)

    await store.getState().synchronize('task-1')

    expect(store.getState().details.map(({ set }) => set.version)).toEqual([2, 1])
    expect(store.getState().details[0]?.criteria).toHaveLength(1)
    expect(store.getState().error).toBeUndefined()
  })

  it('adds, edits, and removes criteria on a draft set', async () => {
    const draft = makeSet()
    const context = setup({ sets: [draft] })
    const store = createCriteriaStore(() => context.bridge)
    await store.getState().synchronize('task-1')

    expect(
      await store.getState().addCriterion({
        setId: draft.id,
        description: 'Build passes',
        category: 'test',
        required: true,
      }),
    ).toBe(true)
    let criteria = store.getState().details[0]?.criteria
    expect(criteria).toHaveLength(1)
    expect(criteria?.[0]).toMatchObject({ description: 'Build passes', category: 'test' })

    expect(
      await store.getState().updateCriterion({
        criterionId: criteria![0]!.id,
        description: 'All tests pass',
        category: null,
        required: false,
      }),
    ).toBe(true)
    criteria = store.getState().details[0]?.criteria
    expect(criteria?.[0]).toMatchObject({
      description: 'All tests pass',
      required: false,
    })
    expect(criteria?.[0]?.category).toBeUndefined()

    expect(await store.getState().removeCriterion(criteria![0]!.id)).toBe(true)
    expect(store.getState().details[0]?.criteria).toEqual([])
  })

  it('confirms a draft into an immutable confirmed version and supersedes the old one', async () => {
    const confirmed = makeSet({ version: 1, status: 'confirmed' })
    const draft = makeSet({ version: 2 })
    const context = setup({
      sets: [confirmed, draft],
      criteria: [makeCriterion(confirmed.id, 1), makeCriterion(draft.id, 1)],
    })
    const store = createCriteriaStore(() => context.bridge)
    await store.getState().synchronize('task-1')

    expect(await store.getState().confirmSet(draft.id)).toBe(true)

    const byVersion = new Map(store.getState().details.map((detail) => [detail.set.version, detail]))
    expect(byVersion.get(2)?.set.status).toBe('confirmed')
    expect(byVersion.get(2)?.set.confirmedAt).toBeDefined()
    expect(byVersion.get(1)?.set.status).toBe('superseded')
  })

  it('creates a new draft version copying the confirmed content', async () => {
    const confirmed = makeSet({ status: 'confirmed' })
    const context = setup({
      sets: [confirmed],
      criteria: [
        makeCriterion(confirmed.id, 1, { description: 'A', category: 'functional' }),
        makeCriterion(confirmed.id, 2, { description: 'B', required: false }),
      ],
    })
    const store = createCriteriaStore(() => context.bridge)
    await store.getState().synchronize('task-1')

    expect(await store.getState().createDraftSet('task-1', confirmed.id)).toBe(true)

    const draft = editableCriteriaDetail(store.getState().details)
    expect(draft?.set.version).toBe(2)
    expect(draft?.criteria.map(({ description }) => description)).toEqual(['A', 'B'])
    expect(draft?.criteria[0]).toMatchObject({ category: 'functional', required: true })
    expect(draft?.criteria[1]?.required).toBe(false)
    expect(
      store.getState().details.find(({ set }) => set.id === confirmed.id)?.set.status,
    ).toBe('confirmed')
  })

  it('surfaces bridge rejections without mutating state (confirmed set stays immutable)', async () => {
    const confirmed = makeSet({ status: 'confirmed' })
    const context = setup({
      sets: [confirmed],
      criteria: [makeCriterion(confirmed.id, 1)],
    })
    const store = createCriteriaStore(() => context.bridge)
    await store.getState().synchronize('task-1')

    expect(
      await store.getState().addCriterion({ setId: confirmed.id, description: 'Nope' }),
    ).toBe(false)
    expect(store.getState().error?.message).toBe(rejected.message)
    expect(store.getState().details[0]?.criteria).toHaveLength(1)

    expect(await store.getState().confirmSet(confirmed.id)).toBe(false)
    expect(store.getState().details[0]?.set.status).toBe('confirmed')

    store.getState().clearError()
    expect(store.getState().error).toBeUndefined()
  })

  it('maps bridge exceptions to a transport error', async () => {
    const context = setup()
    context.bridge.criteria.listSets = vi.fn(async () => {
      throw new Error('ipc down')
    })
    const store = createCriteriaStore(() => context.bridge)

    await store.getState().synchronize('task-1')

    expect(store.getState().error?.code).toBe('UNKNOWN')
    expect(store.getState().loading).toBe(false)
  })

  it('refreshes when the Task is updated elsewhere', async () => {
    const draft = makeSet()
    const context = setup({ sets: [draft] })
    const store = createCriteriaStore(() => context.bridge)
    const stop = store.getState().startSynchronization('task-1')
    await vi.waitFor(() => expect(store.getState().loading).toBe(false))

    await context.bridge.criteria.addCriterion({ setId: draft.id, description: 'External' })
    context.emit('task-1')
    await vi.waitFor(() =>
      expect(store.getState().details[0]?.criteria).toHaveLength(1),
    )
    context.emit('other-task')
    expect(store.getState().details[0]?.criteria).toHaveLength(1)
    stop()
  })
})
