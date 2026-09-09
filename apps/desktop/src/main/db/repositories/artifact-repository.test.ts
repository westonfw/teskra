import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import { ISO_UTC_PATTERN } from './common'
import { createArtifactRepository, type ArtifactRepository } from './artifact-repository'

let connection: Database.Database
let repo: ArtifactRepository

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
  connection
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
       VALUES ('run-1', 'ws-1', 'codex', 'running', 'attended', 'runs/run-1', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
    )
    .run()
  repo = createArtifactRepository(connection)
}

afterEach(() => {
  connection.close()
})

describe('ArtifactRepository', () => {
  it('creates and reads back an artifact with metadata roundtrip', () => {
    setup()
    const created = repo.create({
      id: 'art-1',
      taskId: 'task-1',
      runId: 'run-1',
      type: 'implementation',
      name: 'implementation.md',
      content: '# Done',
      metadata: { lines: 10 },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.metadata).toEqual({ lines: 10 })
    expect(created.data.createdAt).toMatch(ISO_UTC_PATTERN)
    expect(repo.getById('art-1')).toEqual(created)
    expect(repo.getById('missing')).toEqual({ ok: true, data: null })
  })

  it('updates content / file_path / metadata', () => {
    setup()
    repo.create({ id: 'art-1', taskId: 'task-1', type: 'diff', name: 'diff.patch' })
    const updated = repo.update('art-1', {
      filePath: 'runs/run-1/artifacts/diff.patch',
      metadata: { files: 3 },
    })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.data?.filePath).toBe('runs/run-1/artifacts/diff.patch')
    expect(updated.data?.metadata).toEqual({ files: 3 })
  })

  it('lists by task with optional type filter, and by run', () => {
    setup()
    repo.create({ id: 'a1', taskId: 'task-1', runId: 'run-1', type: 'plan', name: 'p' })
    repo.create({ id: 'a2', taskId: 'task-1', runId: 'run-1', type: 'review', name: 'r' })

    const plans = repo.listByTask('task-1', 'plan')
    expect(plans.ok && plans.data.map((a) => a.id)).toEqual(['a1'])
    const all = repo.listByTask('task-1')
    expect(all.ok && all.data.length).toBe(2)
    const byRun = repo.listByRun('run-1')
    expect(byRun.ok && byRun.data.length).toBe(2)
  })

  it('deletes an artifact', () => {
    setup()
    repo.create({ id: 'a1', taskId: 'task-1', type: 'plan', name: 'p' })
    expect(repo.delete('a1')).toEqual({ ok: true, data: true })
    expect(repo.delete('a1')).toEqual({ ok: true, data: false })
  })

  it('returns VALIDATION_FAILED for corrupted metadata_json', () => {
    setup()
    repo.create({ id: 'a1', taskId: 'task-1', type: 'plan', name: 'p' })
    connection.prepare('UPDATE artifacts SET metadata_json = ? WHERE id = ?').run('{', 'a1')

    const result = repo.getById('a1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects a stored type outside the contracts ArtifactType enum', () => {
    setup()
    repo.create({ id: 'a1', taskId: 'task-1', type: 'plan', name: 'p' })
    connection.prepare('UPDATE artifacts SET type = ? WHERE id = ?').run('screenshot', 'a1')

    const result = repo.getById('a1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })
})
