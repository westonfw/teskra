import Database from 'better-sqlite3'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { WorkflowDefinition } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import { createTaskRepository } from '../db/repositories/task-repository'
import { createWorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { createWorkflowRunStore, type WorkflowRunStore } from './workflow-run-store'

/**
 * TASK-056 acceptance: a WorkflowRun can exist independently of any Task,
 * records step statuses through a state machine, records iterations, and is
 * fully recoverable after an app restart (fresh store instance — and a
 * reopened database file — read back the complete state).
 */

const DEFINITION: WorkflowDefinition = {
  id: 'full-review',
  steps: [
    { id: 'implement', type: 'agent', agent: 'codex', runOn: 'first' },
    {
      id: 'review',
      type: 'review-panel',
      agents: ['claude', 'codex'],
      dependsOn: ['implement'],
      runOn: 'always',
    },
  ],
}

const tempDirs: string[] = []
const openConnections: Database.Database[] = []

function track(connection: Database.Database): Database.Database {
  openConnections.push(connection)
  return connection
}

afterEach(() => {
  for (const connection of openConnections.splice(0)) {
    connection.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function memoryDb(): Database.Database {
  const connection = track(new Database(':memory:'))
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  return connection
}

function fileDb(path: string): Database.Database {
  const connection = track(new Database(path))
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  return connection
}

function seedTask(connection: Database.Database): void {
  connection
    .prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at)
       VALUES ('task-1', 'ws-1', 'T', 'ready', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
    )
    .run()
}

function makeStore(connection: Database.Database): WorkflowRunStore {
  return createWorkflowRunStore({
    workflowRuns: createWorkflowRunRepository(connection),
    tasks: createTaskRepository(connection),
  })
}

describe('WorkflowRunStore (TASK-056)', () => {
  it('creates a run independent of any Task and lists it', () => {
    const store = makeStore(memoryDb())
    const created = store.createRun({ definition: DEFINITION, totalIterations: 2 })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.run.taskId).toBeUndefined()
    expect(created.data.run.status).toBe('created')
    expect(created.data.run.currentIteration).toBe(0)
    expect(created.data.run.totalIterations).toBe(2)
    expect(created.data.run.workflowDefinitionId).toBe('full-review')
    // The definition snapshot is bound to the run.
    expect(created.data.run.definition.id).toBe('full-review')
    expect(created.data.run.definition.steps).toHaveLength(2)

    const listed = store.listRuns()
    expect(listed.ok && listed.data.map((run) => run.id)).toEqual([created.data.run.id])
  })

  it('creates a run bound to an existing Task and rejects an unknown one', () => {
    const connection = memoryDb()
    seedTask(connection)
    const store = makeStore(connection)

    const bound = store.createRun({ definition: DEFINITION, taskId: 'task-1' })
    expect(bound.ok && bound.data.run.taskId).toBe('task-1')
    const byTask = store.listRuns({ taskId: 'task-1' })
    expect(byTask.ok && byTask.data).toHaveLength(1)

    const unknown = store.createRun({ definition: DEFINITION, taskId: 'ghost' })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('VALIDATION_FAILED')
  })

  it('refuses to create a run from an invalid definition', () => {
    const store = makeStore(memoryDb())
    const cyclic = {
      id: 'cyclic',
      steps: [
        { id: 'a', type: 'shell', command: 'true', dependsOn: ['b'] },
        { id: 'b', type: 'shell', command: 'true', dependsOn: ['a'] },
      ],
    }
    const result = store.createRun({ definition: cyclic })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(store.listRuns()).toEqual({ ok: true, data: [] })
  })

  it('records steps with the definition node metadata and current iteration', () => {
    const store = makeStore(memoryDb())
    const created = store.createRun({ definition: DEFINITION })
    if (!created.ok) throw new Error('expected run')
    const runId = created.data.run.id

    const step = store.addStep(runId, 'implement')
    expect(step.ok).toBe(true)
    if (!step.ok) return
    expect(step.data.status).toBe('pending')
    expect(step.data.nodeType).toBe('agent')
    expect(step.data.iteration).toBe(0)
    expect(step.data.attempt).toBe(1)
    expect(step.data.dependsOn).toEqual([])

    const review = store.addStep(runId, 'review')
    expect(review.ok && review.data.dependsOn).toEqual(['implement'])

    const unknown = store.addStep(runId, 'ghost')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('VALIDATION_FAILED')
  })

  it('drives the step state machine and rejects illegal transitions', () => {
    const store = makeStore(memoryDb())
    const created = store.createRun({ definition: DEFINITION })
    if (!created.ok) throw new Error('expected run')
    const step = store.addStep(created.data.run.id, 'implement')
    if (!step.ok) throw new Error('expected step')

    // pending → completed directly is illegal.
    const illegal = store.transitionStep(step.data.id, 'completed')
    expect(illegal.ok).toBe(false)
    if (!illegal.ok) {
      expect(illegal.error.code).toBe('VALIDATION_FAILED')
      expect(illegal.error.message).toContain('pending')
      expect(illegal.error.message).toContain('completed')
    }

    const running = store.transitionStep(step.data.id, 'running')
    expect(running.ok && running.data.status).toBe('running')
    expect(running.ok && running.data.startedAt).toBeDefined()

    const finished = store.transitionStep(step.data.id, 'completed', {
      result: { summary: 'done' },
    })
    expect(finished.ok && finished.data.status).toBe('completed')
    expect(finished.ok && finished.data.finishedAt).toBeDefined()
    expect(finished.ok && finished.data.result).toEqual({ summary: 'done' })

    // Terminal states have no exits.
    const resurrect = store.transitionStep(step.data.id, 'running')
    expect(resurrect.ok).toBe(false)

    // pending → skipped is legal (condition edge not activated, plan §153).
    const other = store.addStep(created.data.run.id, 'review')
    if (!other.ok) throw new Error('expected step')
    expect(store.transitionStep(other.data.id, 'skipped').ok).toBe(true)
  })

  it('records iterations on the run and per-iteration step rows', () => {
    const store = makeStore(memoryDb())
    const created = store.createRun({ definition: DEFINITION, totalIterations: 2 })
    if (!created.ok) throw new Error('expected run')
    const runId = created.data.run.id

    store.addStep(runId, 'implement')
    const advanced = store.advanceIteration(runId)
    expect(advanced.ok && advanced.data.currentIteration).toBe(1)
    // The same node id gets a new step row for the next iteration (plan §153).
    const second = store.addStep(runId, 'implement')
    expect(second.ok && second.data.iteration).toBe(1)

    expect(store.advanceIteration(runId).ok).toBe(true)
    // totalIterations = 2 → a third advance is refused.
    const beyond = store.advanceIteration(runId)
    expect(beyond.ok).toBe(false)
    if (!beyond.ok) expect(beyond.error.code).toBe('VALIDATION_FAILED')

    const detail = store.getRun(runId)
    expect(detail.ok && detail.data?.steps).toHaveLength(2)
    expect(detail.ok && detail.data?.steps.map((step) => step.iteration)).toEqual([0, 1])
  })

  it('refuses iteration advance / step creation on a terminal run', () => {
    const store = makeStore(memoryDb())
    const created = store.createRun({ definition: DEFINITION })
    if (!created.ok) throw new Error('expected run')
    const runId = created.data.run.id

    const completed = store.setRunStatus(runId, 'completed')
    expect(completed.ok && completed.data.status).toBe('completed')
    expect(completed.ok && completed.data.completedAt).toBeDefined()

    expect(store.advanceIteration(runId).ok).toBe(false)
    expect(store.addStep(runId, 'implement').ok).toBe(false)
  })

  it('recovers the complete state with a fresh store instance (restart over the same DB)', () => {
    const connection = memoryDb()
    const first = makeStore(connection)
    const created = first.createRun({ definition: DEFINITION, totalIterations: 3 })
    if (!created.ok) throw new Error('expected run')
    const runId = created.data.run.id
    const step = first.addStep(runId, 'implement')
    if (!step.ok) throw new Error('expected step')
    first.transitionStep(step.data.id, 'running')
    first.transitionStep(step.data.id, 'failed')
    first.advanceIteration(runId)
    first.addStep(runId, 'implement')
    first.setRunStatus(runId, 'waiting')

    // Simulated restart: a brand-new service instance over the same database.
    const recovered = makeStore(connection)
    const detail = recovered.getRun(runId)
    expect(detail.ok).toBe(true)
    if (!detail.ok || detail.data === null) throw new Error('expected recovered run')
    expect(detail.data.run.status).toBe('waiting')
    expect(detail.data.run.currentIteration).toBe(1)
    expect(detail.data.run.totalIterations).toBe(3)
    expect(detail.data.run.definition).toEqual(created.data.run.definition)
    expect(detail.data.steps).toHaveLength(2)
    expect(detail.data.steps[0]).toMatchObject({
      nodeId: 'implement',
      status: 'failed',
      iteration: 0,
    })
    expect(detail.data.steps[1]).toMatchObject({
      nodeId: 'implement',
      status: 'pending',
      iteration: 1,
    })

    const listed = recovered.listRuns({ status: 'waiting' })
    expect(listed.ok && listed.data.map((run) => run.id)).toEqual([runId])
  })

  it('recovers the complete state after closing and reopening the database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teskra-workflow-store-'))
    tempDirs.push(dir)
    const dbFile = join(dir, 'teskra.sqlite')

    const first = makeStore(fileDb(dbFile))
    const created = first.createRun({ definition: DEFINITION, totalIterations: 2 })
    if (!created.ok) throw new Error('expected run')
    const runId = created.data.run.id
    first.addStep(runId, 'review')
    first.advanceIteration(runId)
    openConnections.pop()?.close()

    const recovered = makeStore(fileDb(dbFile))
    const detail = recovered.getRun(runId)
    expect(detail.ok && detail.data?.run.currentIteration).toBe(1)
    expect(detail.ok && detail.data?.steps).toHaveLength(1)
    expect(detail.ok && detail.data?.run.definition.steps.map((node) => node.id)).toEqual([
      'implement',
      'review',
    ])
  })
})
