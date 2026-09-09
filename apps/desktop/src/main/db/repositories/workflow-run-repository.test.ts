import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import { ISO_UTC_PATTERN } from './common'
import { createWorkflowRunRepository, type WorkflowRunRepository } from './workflow-run-repository'

let connection: Database.Database
let repo: WorkflowRunRepository

function setup() {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
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
  repo = createWorkflowRunRepository(connection)
}

afterEach(() => {
  connection.close()
})

describe('WorkflowRunRepository', () => {
  it('creates a run with its definition snapshot and reads it back', () => {
    setup()
    const created = repo.createRun({
      id: 'wf-1',
      taskId: 'task-1',
      workflowDefinitionId: 'default',
      definition: { nodes: ['implement', 'review'] },
      totalIterations: 2,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.status).toBe('created')
    expect(created.data.definition).toEqual({ nodes: ['implement', 'review'] })
    expect(created.data.totalIterations).toBe(2)
    expect(created.data.createdAt).toMatch(ISO_UTC_PATTERN)
    expect(repo.getRunById('wf-1')).toEqual(created)
  })

  it('updates run progress and completion', () => {
    setup()
    repo.createRun({
      id: 'wf-1',
      taskId: 'task-1',
      workflowDefinitionId: 'default',
      definition: {},
    })
    const updated = repo.updateRun('wf-1', {
      status: 'completed',
      currentIteration: 1,
      completedAt: '2026-09-09T12:00:00.000Z',
    })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.data?.status).toBe('completed')
    expect(updated.data?.completedAt).toBe('2026-09-09T12:00:00.000Z')
  })

  it('lists runs by task with status filter', () => {
    setup()
    repo.createRun({ id: 'wf-1', taskId: 'task-1', workflowDefinitionId: 'd', definition: {} })
    repo.createRun({
      id: 'wf-2',
      taskId: 'task-1',
      workflowDefinitionId: 'd',
      definition: {},
      status: 'running',
    })
    const running = repo.listRunsByTask('task-1', 'running')
    expect(running.ok && running.data.map((run) => run.id)).toEqual(['wf-2'])
  })

  it('creates and updates steps with depends_on / result roundtrip', () => {
    setup()
    repo.createRun({ id: 'wf-1', taskId: 'task-1', workflowDefinitionId: 'd', definition: {} })
    const step = repo.createStep({
      id: 'step-1',
      workflowRunId: 'wf-1',
      nodeId: 'review',
      nodeType: 'review-panel',
      iteration: 1,
      dependsOn: ['implement'],
    })
    expect(step.ok).toBe(true)
    if (!step.ok) return
    expect(step.data.status).toBe('pending')
    expect(step.data.attempt).toBe(1)
    expect(step.data.dependsOn).toEqual(['implement'])

    const finished = repo.updateStep('step-1', {
      status: 'completed',
      result: { consensus: 'approve' },
      startedAt: '2026-09-09T10:00:00.000Z',
      finishedAt: '2026-09-09T11:00:00.000Z',
    })
    expect(finished.ok).toBe(true)
    if (!finished.ok) return
    expect(finished.data?.result).toEqual({ consensus: 'approve' })

    const steps = repo.listSteps('wf-1')
    expect(steps.ok && steps.data.length).toBe(1)
  })

  it('returns VALIDATION_FAILED for corrupted definition_json', () => {
    setup()
    repo.createRun({ id: 'wf-1', taskId: 'task-1', workflowDefinitionId: 'd', definition: {} })
    connection
      .prepare('UPDATE workflow_runs SET definition_json = ? WHERE id = ?')
      .run('not json', 'wf-1')

    const result = repo.getRunById('wf-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects a stored step status outside the workflow step enum', () => {
    setup()
    repo.createRun({ id: 'wf-1', taskId: 'task-1', workflowDefinitionId: 'd', definition: {} })
    repo.createStep({ id: 'step-1', workflowRunId: 'wf-1', nodeId: 'n', nodeType: 'agent' })
    connection
      .prepare('UPDATE workflow_steps SET status = ? WHERE id = ?')
      .run('exploded', 'step-1')

    const result = repo.getStepById('step-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('deletes a run and cascades its steps', () => {
    setup()
    repo.createRun({ id: 'wf-1', taskId: 'task-1', workflowDefinitionId: 'd', definition: {} })
    repo.createStep({ id: 'step-1', workflowRunId: 'wf-1', nodeId: 'n', nodeType: 'agent' })
    expect(repo.deleteRun('wf-1')).toEqual({ ok: true, data: true })
    expect(repo.getStepById('step-1')).toEqual({ ok: true, data: null })
  })
})
