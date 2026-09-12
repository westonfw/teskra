import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import { ISO_UTC_PATTERN } from './common'
import { createTaskRepository, type TaskRepository } from './task-repository'

let connection: Database.Database
let repo: TaskRepository

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
  repo = createTaskRepository(connection)
}

afterEach(() => {
  connection.close()
})

describe('TaskRepository', () => {
  it('creates a draft task by default and reads it back', () => {
    setup()
    const created = repo.create({ id: 't-1', workspaceId: 'ws-1', title: 'First' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.status).toBe('draft')
    expect(created.data.createdAt).toMatch(ISO_UTC_PATTERN)
    expect(created.data.updatedAt).toMatch(ISO_UTC_PATTERN)
    expect(repo.getById('t-1')).toEqual(created)
    expect(repo.getById('missing')).toEqual({ ok: true, data: null })
  })

  it('updates fields and status', () => {
    setup()
    repo.create({ id: 't-1', workspaceId: 'ws-1', title: 'First' })
    const updated = repo.updateStatus('t-1', 'running', '2026-09-09T12:00:00.000Z')
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.data?.status).toBe('running')
    expect(updated.data?.updatedAt).toBe('2026-09-09T12:00:00.000Z')
  })

  it('lists by workspace with status and archive filters', () => {
    setup()
    repo.create({ id: 't-1', workspaceId: 'ws-1', title: 'A', status: 'ready' })
    repo.create({ id: 't-2', workspaceId: 'ws-1', title: 'B', status: 'running' })
    repo.create({ id: 't-3', workspaceId: 'ws-1', title: 'C', status: 'running' })
    repo.update('t-3', { archivedAt: '2026-09-09T12:00:00.000Z' })

    const running = repo.listByWorkspace('ws-1', { status: 'running' })
    expect(running.ok && running.data.map((t) => t.id)).toEqual(['t-2'])

    const withArchived = repo.listByWorkspace('ws-1', { includeArchived: true })
    expect(withArchived.ok && withArchived.data.length).toBe(3)

    const all = repo.listByWorkspace('ws-1')
    expect(all.ok && all.data.length).toBe(2)
  })

  it('deletes a task', () => {
    setup()
    repo.create({ id: 't-1', workspaceId: 'ws-1', title: 'A' })
    expect(repo.delete('t-1')).toEqual({ ok: true, data: true })
    expect(repo.delete('t-1')).toEqual({ ok: true, data: false })
  })

  const NOW = '2026-09-09T00:00:00.000Z'

  function insertCriteriaSet(id: string, taskId: string) {
    connection
      .prepare(
        `INSERT INTO acceptance_criteria_sets (id, task_id, version, status, created_at)
         VALUES (?, ?, 1, 'confirmed', ?)`,
      )
      .run(id, taskId, NOW)
  }

  function insertCriterion(id: string, setId: string) {
    connection
      .prepare(
        `INSERT INTO acceptance_criteria (id, criteria_set_id, ordinal, description, required, created_at)
         VALUES (?, ?, 1, 'it works', 1, ?)`,
      )
      .run(id, setId, NOW)
  }

  function insertRun(id: string, taskId: string, criteriaSetId?: string) {
    connection
      .prepare(
        `INSERT INTO agent_runs
           (id, task_id, workspace_id, agent_type, status, execution_mode, criteria_set_id,
            run_dir, created_at, updated_at)
         VALUES (?, ?, 'ws-1', 'claude', 'completed', 'orchestrated', ?, ?, ?, ?)`,
      )
      .run(id, taskId, criteriaSetId ?? null, `/runs/${id}`, NOW, NOW)
  }

  it('keeps runs and their anchored criteria sets as orphans when deleting the task (ADR-0007)', () => {
    setup()
    repo.create({ id: 't-1', workspaceId: 'ws-1', title: 'A' })
    insertCriteriaSet('cs-1', 't-1')
    insertCriterion('c-1', 'cs-1')
    insertRun('run-1', 't-1', 'cs-1')

    expect(repo.delete('t-1')).toEqual({ ok: true, data: true })

    const run = connection
      .prepare('SELECT task_id, criteria_set_id FROM agent_runs WHERE id = ?')
      .get('run-1') as { task_id: string | null; criteria_set_id: string | null }
    expect(run.task_id).toBeNull()
    expect(run.criteria_set_id).toBe('cs-1')

    const set = connection
      .prepare('SELECT task_id FROM acceptance_criteria_sets WHERE id = ?')
      .get('cs-1') as { task_id: string | null } | undefined
    expect(set?.task_id).toBeNull()
  })

  it('sweeps criteria sets no audit row references when deleting the task', () => {
    setup()
    repo.create({ id: 't-1', workspaceId: 'ws-1', title: 'A' })
    insertCriteriaSet('cs-1', 't-1')
    insertCriterion('c-1', 'cs-1')

    expect(repo.delete('t-1')).toEqual({ ok: true, data: true })
    expect(
      connection
        .prepare('SELECT COUNT(*) AS n FROM acceptance_criteria_sets WHERE id = ?')
        .get('cs-1'),
    ).toEqual({ n: 0 })
    expect(
      connection.prepare('SELECT COUNT(*) AS n FROM acceptance_criteria WHERE id = ?').get('c-1'),
    ).toEqual({ n: 0 })
  })

  it('keeps a set whose criterion a review finding cites, even with no run anchoring it', () => {
    setup()
    repo.create({ id: 't-1', workspaceId: 'ws-1', title: 'A' })
    insertCriteriaSet('cs-1', 't-1')
    insertCriterion('c-1', 'cs-1')
    insertRun('run-1', 't-1')
    connection
      .prepare(
        `INSERT INTO review_findings (id, run_id, severity, title, criterion_id, created_at)
         VALUES ('rf-1', 'run-1', 'low', 'note', 'c-1', ?)`,
      )
      .run(NOW)

    expect(repo.delete('t-1')).toEqual({ ok: true, data: true })
    expect(
      connection.prepare('SELECT task_id FROM acceptance_criteria_sets WHERE id = ?').get('cs-1'),
    ).toEqual({ task_id: null })
  })

  it('rejects a stored status outside the contracts TaskStatus enum', () => {
    setup()
    repo.create({ id: 't-1', workspaceId: 'ws-1', title: 'A' })
    connection.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('limbo', 't-1')

    const result = repo.getById('t-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('surfaces FK violations as structured errors, not raw throws', () => {
    setup()
    const result = repo.create({ id: 't-x', workspaceId: 'ghost', title: 'Orphan' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('UNKNOWN')
  })
})
