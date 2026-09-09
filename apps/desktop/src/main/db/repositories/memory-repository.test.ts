import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import { ISO_UTC_PATTERN } from './common'
import { createMemoryRepository, type MemoryRepository } from './memory-repository'

let connection: Database.Database
let repo: MemoryRepository

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
  repo = createMemoryRepository(connection)
}

afterEach(() => {
  connection.close()
})

describe('MemoryRepository', () => {
  it('creates and reads back a memory', () => {
    setup()
    const created = repo.create({
      id: 'm-1',
      workspaceId: 'ws-1',
      type: 'convention',
      content: 'Use Conventional Commits',
      source: 'manual',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.createdAt).toMatch(ISO_UTC_PATTERN)
    expect(repo.getById('m-1')).toEqual(created)
  })

  it('updates content and bumps updated_at', () => {
    setup()
    repo.create({ id: 'm-1', workspaceId: 'ws-1', type: 'summary', content: 'v1' })
    const updated = repo.update('m-1', { content: 'v2' }, '2026-09-09T13:00:00.000Z')
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.data?.content).toBe('v2')
    expect(updated.data?.updatedAt).toBe('2026-09-09T13:00:00.000Z')
  })

  it('lists by workspace with optional type filter', () => {
    setup()
    repo.create({ id: 'm-1', workspaceId: 'ws-1', type: 'decision', content: 'a' })
    repo.create({ id: 'm-2', workspaceId: 'ws-1', type: 'command', content: 'b' })

    const decisions = repo.listByWorkspace('ws-1', 'decision')
    expect(decisions.ok && decisions.data.map((m) => m.id)).toEqual(['m-1'])
    const all = repo.listByWorkspace('ws-1')
    expect(all.ok && all.data.length).toBe(2)
  })

  it('rejects a stored type outside the contracts MemoryType enum', () => {
    setup()
    repo.create({ id: 'm-1', workspaceId: 'ws-1', type: 'summary', content: 'x' })
    connection.prepare('UPDATE memories SET type = ? WHERE id = ?').run('dream', 'm-1')

    const result = repo.getById('m-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('deletes a memory', () => {
    setup()
    repo.create({ id: 'm-1', workspaceId: 'ws-1', type: 'summary', content: 'x' })
    expect(repo.delete('m-1')).toEqual({ ok: true, data: true })
    expect(repo.delete('m-1')).toEqual({ ok: true, data: false })
  })
})
