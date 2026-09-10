import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkbenchEvents } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import {
  createAgentRunRepository,
  createCriteriaRepository,
  createTaskRepository,
  createWorkspaceRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createCriteriaManager, type CriteriaManager } from './criteria-manager'

let connection: Database.Database
let events: EventBus<WorkbenchEvents>
let manager: CriteriaManager
let criteriaRepo: ReturnType<typeof createCriteriaRepository>
let agentRuns: ReturnType<typeof createAgentRunRepository>
let idCounter: number

const NOW = '2026-09-10T00:00:00.000Z'

function nextId(): string {
  idCounter += 1
  return `id-${String(idCounter)}`
}

function createRun(id: string, taskId?: string): void {
  const created = agentRuns.create({
    id,
    workspaceId: 'workspace-1',
    ...(taskId === undefined ? {} : { taskId }),
    agentType: 'codex',
    executionMode: 'attended',
    runDir: `/runs/${id}`,
  })
  if (!created.ok) throw new Error(created.error.message)
}

beforeEach(() => {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  const workspaces = createWorkspaceRepository(connection)
  const workspace = workspaces.create({
    id: 'workspace-1',
    name: 'Demo',
    runtime: { kind: 'windows' },
    path: 'C:\\repo',
  })
  if (!workspace.ok) throw new Error(workspace.error.message)
  const tasks = createTaskRepository(connection)
  for (const id of ['task-1', 'task-2']) {
    const task = tasks.create({ id, workspaceId: 'workspace-1', title: id }, NOW)
    if (!task.ok) throw new Error(task.error.message)
  }
  events = createEventBus<WorkbenchEvents>()
  criteriaRepo = createCriteriaRepository(connection)
  agentRuns = createAgentRunRepository(connection)
  idCounter = 0
  manager = createCriteriaManager({
    criteria: criteriaRepo,
    tasks,
    runs: agentRuns,
    events,
    createId: nextId,
    now: () => NOW,
  })
})

afterEach(() => connection.close())

/** Creates a draft set with one required criterion and confirms it. */
function confirmedSet(taskId: string, description: string) {
  const created = manager.createSet({ taskId })
  if (!created.ok) throw new Error(created.error.message)
  const added = manager.addCriterion({ setId: created.data.set.id, description })
  if (!added.ok) throw new Error(added.error.message)
  const confirmed = manager.confirmSet({ setId: created.data.set.id })
  if (!confirmed.ok) throw new Error(confirmed.error.message)
  return confirmed.data
}

describe('CriteriaManager (TASK-048)', () => {
  it('creates draft sets as the next version and lists every version of a Task', () => {
    const first = manager.createSet({ taskId: 'task-1' })
    expect(first).toMatchObject({
      ok: true,
      data: { set: { taskId: 'task-1', version: 1, status: 'draft' }, criteria: [] },
    })
    const second = manager.createSet({ taskId: 'task-1' })
    expect(second).toMatchObject({ ok: true, data: { set: { version: 2, status: 'draft' } } })

    expect(manager.listSets({ taskId: 'task-1' })).toMatchObject({
      ok: true,
      data: [{ version: 2 }, { version: 1 }],
    })
    expect(manager.createSet({ taskId: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
  })

  it('edits criteria while a set is draft and emits task.updated', () => {
    const updatedEvent = vi.fn()
    events.subscribe('task.updated', updatedEvent)

    const created = manager.createSet({ taskId: 'task-1' })
    if (!created.ok) throw new Error(created.error.message)
    const setId = created.data.set.id

    const added = manager.addCriterion({
      setId,
      description: 'Schema matches plan §139.1',
      category: 'functional',
    })
    expect(added).toMatchObject({
      ok: true,
      data: { criteriaSetId: setId, ordinal: 1, required: true, category: 'functional' },
    })
    const second = manager.addCriterion({ setId, description: 'All unit tests pass' })
    expect(second).toMatchObject({ ok: true, data: { ordinal: 2 } })

    if (!added.ok) throw new Error(added.error.message)
    expect(
      manager.updateCriterion({
        criterionId: added.data.id,
        description: 'Schema matches §139.1 exactly',
        category: null,
        required: false,
      }),
    ).toMatchObject({
      ok: true,
      data: { description: 'Schema matches §139.1 exactly', category: undefined, required: false },
    })

    if (!second.ok) throw new Error(second.error.message)
    expect(manager.removeCriterion({ criterionId: second.data.id })).toEqual({
      ok: true,
      data: true,
    })
    expect(manager.getSet({ setId })).toMatchObject({
      ok: true,
      data: { criteria: [{ ordinal: 1 }] },
    })
    expect(manager.getSet({ setId: 'missing' })).toEqual({ ok: true, data: null })
    // createSet + add + add + update + remove
    expect(updatedEvent).toHaveBeenCalledTimes(5)
    expect(updatedEvent).toHaveBeenLastCalledWith({ taskId: 'task-1' })
  })

  it('locks a confirmed set: criteria mutations are rejected, not silently applied', () => {
    const set = confirmedSet('task-1', 'All unit tests pass')

    expect(manager.addCriterion({ setId: set.id, description: 'Late addition' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
    expect(manager.getSet({ setId: set.id })).toMatchObject({
      ok: true,
      data: { criteria: [{ description: 'All unit tests pass' }] },
    })

    const criteria = criteriaRepo.listCriteria(set.id)
    if (!criteria.ok) throw new Error(criteria.error.message)
    const criterionId = criteria.data[0]?.id
    expect(criterionId).toBeDefined()
    if (criterionId === undefined) return
    expect(
      manager.updateCriterion({ criterionId, description: 'Rewrite confirmed text' }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(manager.removeCriterion({ criterionId })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
    expect(manager.confirmSet({ setId: set.id })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
  })

  it('refuses to confirm an empty set', () => {
    const created = manager.createSet({ taskId: 'task-1' })
    if (!created.ok) throw new Error(created.error.message)
    expect(manager.confirmSet({ setId: created.data.set.id })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
  })

  it('confirming a new version supersedes the previously confirmed set', () => {
    const v1 = confirmedSet('task-1', 'Version 1 contract')
    const v2 = confirmedSet('task-1', 'Version 2 contract')

    expect(v2.version).toBe(2)
    expect(manager.listSets({ taskId: 'task-1' })).toMatchObject({
      ok: true,
      data: [
        { id: v2.id, version: 2, status: 'confirmed' },
        { id: v1.id, version: 1, status: 'superseded' },
      ],
    })

    // Exactly one confirmed set per Task — the invariant MergePreflight's
    // task-level fallback (highest-version confirmed set) relies on.
    const sets = criteriaRepo.listSetsByTask('task-1')
    if (!sets.ok) throw new Error(sets.error.message)
    expect(sets.data.filter((set) => set.status === 'confirmed').map((set) => set.id)).toEqual([
      v2.id,
    ])
  })

  it('supersedes a confirmed set explicitly and rejects invalid transitions', () => {
    const v1 = confirmedSet('task-1', 'Version 1 contract')
    expect(manager.supersedeSet({ setId: v1.id })).toMatchObject({
      ok: true,
      data: { status: 'superseded' },
    })
    // A superseded set is terminal: it cannot be re-confirmed or superseded again.
    expect(manager.supersedeSet({ setId: v1.id })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
    expect(manager.confirmSet({ setId: v1.id })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })

    const draft = manager.createSet({ taskId: 'task-1' })
    if (!draft.ok) throw new Error(draft.error.message)
    expect(manager.supersedeSet({ setId: draft.data.set.id })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
  })

  it('binds a Run to a specific confirmed version and keeps it after supersede', () => {
    const v1 = confirmedSet('task-1', 'Version 1 contract')
    createRun('run-1', 'task-1')

    const bound = manager.bindRun({ runId: 'run-1', setId: v1.id })
    expect(bound).toMatchObject({ ok: true, data: { id: 'run-1', criteriaSetId: v1.id } })

    // A newer confirmed version does not move the run's pinned binding.
    const v2 = confirmedSet('task-1', 'Version 2 contract')
    const run = agentRuns.getById('run-1')
    expect(run).toMatchObject({ ok: true, data: { criteriaSetId: v1.id } })

    expect(manager.bindRun({ runId: 'run-1', setId: v2.id })).toMatchObject({
      ok: true,
      data: { criteriaSetId: v2.id },
    })
    expect(manager.bindRun({ runId: 'run-1', setId: null })).toMatchObject({
      ok: true,
      data: { criteriaSetId: undefined },
    })
  })

  it('rejects binding runs to draft sets, other tasks, or unknown targets', () => {
    const draft = manager.createSet({ taskId: 'task-1' })
    if (!draft.ok) throw new Error(draft.error.message)
    createRun('run-1', 'task-1')
    createRun('run-2', 'task-2')
    createRun('run-3')

    expect(manager.bindRun({ runId: 'run-1', setId: draft.data.set.id })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
    const otherTaskSet = confirmedSet('task-2', 'Other task contract')
    expect(manager.bindRun({ runId: 'run-1', setId: otherTaskSet.id })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
    // A taskless run may bind any confirmed set.
    expect(manager.bindRun({ runId: 'run-3', setId: otherTaskSet.id })).toMatchObject({
      ok: true,
      data: { criteriaSetId: otherTaskSet.id },
    })
    expect(manager.bindRun({ runId: 'missing', setId: null })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
    expect(manager.bindRun({ runId: 'run-1', setId: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
  })

  it('produces sets that MergePreflight (TASK-045) recognizes as confirmed', () => {
    const v1 = confirmedSet('task-1', 'All unit tests pass')
    createRun('run-1', 'task-1')

    // Binding path: run.criteriaSetId → getSetById → status === 'confirmed'.
    expect(manager.bindRun({ runId: 'run-1', setId: v1.id }).ok).toBe(true)
    const run = agentRuns.getById('run-1')
    if (!run.ok || run.data === null) throw new Error('run missing')
    const boundSet = criteriaRepo.getSetById(run.data.criteriaSetId ?? '')
    expect(boundSet).toMatchObject({ ok: true, data: { id: v1.id, status: 'confirmed' } })

    // Fallback path: the task's highest-version confirmed set.
    const sets = criteriaRepo.listSetsByTask('task-1')
    if (!sets.ok) throw new Error(sets.error.message)
    expect(sets.data.find((set) => set.status === 'confirmed')?.id).toBe(v1.id)

    // After supersede, a bound-but-superseded set is no longer "confirmed",
    // so preflight falls back to the newer confirmed version instead.
    const v2 = confirmedSet('task-1', 'Version 2 contract')
    const stale = criteriaRepo.getSetById(v1.id)
    expect(stale).toMatchObject({ ok: true, data: { status: 'superseded' } })
    const refreshed = criteriaRepo.listSetsByTask('task-1')
    if (!refreshed.ok) throw new Error(refreshed.error.message)
    expect(refreshed.data.find((set) => set.status === 'confirmed')?.id).toBe(v2.id)
  })
})
