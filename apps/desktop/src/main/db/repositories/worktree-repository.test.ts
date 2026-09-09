import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import { ISO_UTC_PATTERN } from './common'
import { createWorktreeRepository, type WorktreeRepository } from './worktree-repository'

let connection: Database.Database
let repo: WorktreeRepository

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
  repo = createWorktreeRepository(connection)
}

afterEach(() => {
  connection.close()
})

describe('WorktreeRepository', () => {
  it('creates a worktree in the default creating state', () => {
    setup()
    const created = repo.create({
      id: 'wt-1',
      workspaceId: 'ws-1',
      branch: 'teskra/run-1',
      baseBranch: 'main',
      path: 'C:\\dev\\ws-wt-1',
      isolation: 'worktree',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.state).toBe('creating')
    expect(created.data.createdAt).toMatch(ISO_UTC_PATTERN)
    expect(repo.getById('wt-1')).toEqual(created)
  })

  it('maintains the redundant run_id reverse pointer and resolves it', () => {
    setup()
    repo.create({
      id: 'wt-1',
      workspaceId: 'ws-1',
      branch: 'teskra/run-1',
      baseBranch: 'main',
      path: 'C:\\dev\\ws-wt-1',
      isolation: 'worktree',
    })
    expect(repo.getByRunId('run-1')).toEqual({ ok: true, data: null })

    const linked = repo.update('wt-1', { runId: 'run-1' })
    expect(linked.ok).toBe(true)
    const found = repo.getByRunId('run-1')
    expect(found.ok && found.data?.id).toBe('wt-1')
  })

  it('transitions state and stamps merged_at', () => {
    setup()
    repo.create({
      id: 'wt-1',
      workspaceId: 'ws-1',
      branch: 'b',
      baseBranch: 'main',
      path: 'C:\\wt',
      isolation: 'worktree',
      state: 'ready',
    })
    const merged = repo.update(
      'wt-1',
      { state: 'merged', mergedAt: '2026-09-09T12:00:00.000Z' },
      '2026-09-09T12:00:01.000Z',
    )
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    expect(merged.data?.state).toBe('merged')
    expect(merged.data?.mergedAt).toBe('2026-09-09T12:00:00.000Z')
  })

  it('lists by workspace with state filter', () => {
    setup()
    repo.create({
      id: 'wt-1',
      workspaceId: 'ws-1',
      branch: 'b1',
      baseBranch: 'main',
      path: 'C:\\wt1',
      isolation: 'worktree',
      state: 'ready',
    })
    repo.create({
      id: 'wt-2',
      workspaceId: 'ws-1',
      branch: 'b2',
      baseBranch: 'main',
      path: 'C:\\wt2',
      isolation: 'shared-readonly',
      state: 'dirty',
    })
    const ready = repo.listByWorkspace('ws-1', 'ready')
    expect(ready.ok && ready.data.map((wt) => wt.id)).toEqual(['wt-1'])
    const all = repo.listByWorkspace('ws-1')
    expect(all.ok && all.data.length).toBe(2)
  })

  it('rejects a stored state outside WorktreeState', () => {
    setup()
    repo.create({
      id: 'wt-1',
      workspaceId: 'ws-1',
      branch: 'b',
      baseBranch: 'main',
      path: 'C:\\wt',
      isolation: 'worktree',
    })
    connection.prepare('UPDATE worktrees SET state = ? WHERE id = ?').run('exploded', 'wt-1')

    const result = repo.getById('wt-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('deletes a worktree', () => {
    setup()
    repo.create({
      id: 'wt-1',
      workspaceId: 'ws-1',
      branch: 'b',
      baseBranch: 'main',
      path: 'C:\\wt',
      isolation: 'worktree',
    })
    expect(repo.delete('wt-1')).toEqual({ ok: true, data: true })
  })
})
