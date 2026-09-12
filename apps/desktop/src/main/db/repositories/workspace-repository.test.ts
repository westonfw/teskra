import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import { ISO_UTC_PATTERN } from './common'
import { createWorkspaceRepository, type WorkspaceRepository } from './workspace-repository'

let connection: Database.Database
let repo: WorkspaceRepository

function setup() {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
  repo = createWorkspaceRepository(connection)
}

afterEach(() => {
  connection.close()
})

describe('WorkspaceRepository', () => {
  it('creates and reads back a workspace with ISO-8601 UTC timestamps', () => {
    setup()
    const created = repo.create({
      id: 'ws-1',
      name: 'Demo',
      runtime: { kind: 'windows' },
      path: 'C:\\dev\\demo',
      gitRoot: 'C:\\dev\\demo',
      defaultBranch: 'main',
      env: { FOO: 'bar' },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.createdAt).toMatch(ISO_UTC_PATTERN)
    expect(created.data.updatedAt).toMatch(ISO_UTC_PATTERN)
    expect(created.data.env).toEqual({ FOO: 'bar' })

    const fetched = repo.getById('ws-1')
    expect(fetched).toEqual(created)
  })

  it('returns null for a missing id without throwing', () => {
    setup()
    expect(repo.getById('nope')).toEqual({ ok: true, data: null })
  })

  it('flattens and restores WorkspaceRuntimeRef for every runtime kind', () => {
    setup()
    const cases = [
      { kind: 'windows' },
      { kind: 'wsl', distro: 'Ubuntu-24.04' },
      { kind: 'ssh', host: 'builder.example.com' },
      { kind: 'container', containerId: 'abc123' },
    ] as const
    cases.forEach((runtime, index) => {
      const created = repo.create({
        id: `ws-${index}`,
        name: `WS ${index}`,
        runtime,
        path: `C:\\dev\\ws-${index}`,
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      expect(created.data.runtime).toEqual(runtime)

      // Verify the flat columns actually hold the ref parts.
      const row = connection
        .prepare(
          'SELECT runtime_kind, wsl_distro, ssh_host, container_id FROM workspaces WHERE id = ?',
        )
        .get(`ws-${index}`) as Record<string, string | null>
      expect(row.runtime_kind).toBe(runtime.kind)
      expect(row.wsl_distro).toBe('distro' in runtime ? runtime.distro : null)
      expect(row.ssh_host).toBe('host' in runtime ? runtime.host : null)
      expect(row.container_id).toBe('containerId' in runtime ? runtime.containerId : null)
    })
  })

  it('updates fields and bumps updated_at', () => {
    setup()
    repo.create({ id: 'ws-1', name: 'Demo', runtime: { kind: 'windows' }, path: 'C:\\d' })
    const updated = repo.update(
      'ws-1',
      { name: 'Renamed', lastOpenedAt: '2026-09-09T10:00:00.000Z' },
      '2026-09-09T11:00:00.000Z',
    )
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.data?.name).toBe('Renamed')
    expect(updated.data?.lastOpenedAt).toBe('2026-09-09T10:00:00.000Z')
    expect(updated.data?.updatedAt).toBe('2026-09-09T11:00:00.000Z')

    expect(repo.update('missing', { name: 'x' })).toEqual({ ok: true, data: null })
  })

  it('listRecent orders by last_opened_at with never-opened last', () => {
    setup()
    repo.create({ id: 'ws-a', name: 'A', runtime: { kind: 'windows' }, path: 'C:\\a' })
    repo.create({ id: 'ws-b', name: 'B', runtime: { kind: 'windows' }, path: 'C:\\b' })
    repo.create({ id: 'ws-c', name: 'C', runtime: { kind: 'windows' }, path: 'C:\\c' })
    repo.update('ws-b', { lastOpenedAt: '2026-09-08T09:00:00.000Z' })
    repo.update('ws-a', { lastOpenedAt: '2026-09-09T09:00:00.000Z' })

    const recent = repo.listRecent(10)
    expect(recent.ok).toBe(true)
    if (!recent.ok) return
    expect(recent.data.map((ws) => ws.id)).toEqual(['ws-a', 'ws-b', 'ws-c'])

    const limited = repo.listRecent(1)
    expect(limited.ok && limited.data.map((ws) => ws.id)).toEqual(['ws-a'])
  })

  it('deletes a workspace', () => {
    setup()
    repo.create({ id: 'ws-1', name: 'Demo', runtime: { kind: 'windows' }, path: 'C:\\d' })
    expect(repo.delete('ws-1')).toEqual({ ok: true, data: true })
    expect(repo.delete('ws-1')).toEqual({ ok: true, data: false })
  })

  it('finds a workspace by its (runtime_kind, wsl_distro, path) identity', () => {
    setup()
    repo.create({
      id: 'ws-win',
      name: 'Win',
      runtime: { kind: 'windows' },
      path: 'C:\\dev\\same',
    })
    repo.create({
      id: 'ws-wsl',
      name: 'Wsl',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: '/home/user/same',
    })
    repo.create({
      id: 'ws-wsl-alt',
      name: 'WslAlt',
      runtime: { kind: 'wsl', distro: 'Debian' },
      path: '/home/user/same',
    })

    const win = repo.findByPath({ kind: 'windows' }, 'C:\\dev\\same')
    expect(win.ok && win.data?.id).toBe('ws-win')

    const wsl = repo.findByPath({ kind: 'wsl', distro: 'Ubuntu-24.04' }, '/home/user/same')
    expect(wsl.ok && wsl.data?.id).toBe('ws-wsl')

    // Same path under a different distro is a different workspace.
    const otherDistro = repo.findByPath({ kind: 'wsl', distro: 'Debian' }, '/home/user/same')
    expect(otherDistro.ok && otherDistro.data?.id).toBe('ws-wsl-alt')

    expect(repo.findByPath({ kind: 'windows' }, 'C:\\nope')).toEqual({ ok: true, data: null })
    expect(repo.findByPath({ kind: 'wsl' }, '/home/user/same')).toEqual({
      ok: true,
      data: null,
    })
  })

  it('persists lastOpenedAt given at create time', () => {
    setup()
    const created = repo.create({
      id: 'ws-1',
      name: 'Demo',
      runtime: { kind: 'windows' },
      path: 'C:\\d',
      lastOpenedAt: '2026-09-09T10:00:00.000Z',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.lastOpenedAt).toBe('2026-09-09T10:00:00.000Z')
  })

  it('returns VALIDATION_FAILED for corrupted env_json instead of throwing', () => {
    setup()
    repo.create({ id: 'ws-1', name: 'Demo', runtime: { kind: 'windows' }, path: 'C:\\d' })
    connection.prepare('UPDATE workspaces SET env_json = ? WHERE id = ?').run('{not json', 'ws-1')

    const result = repo.getById('ws-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(result.error).not.toHaveProperty('detail')
    expect(result.error).not.toHaveProperty('cause')
  })

  it('returns VALIDATION_FAILED for an invalid runtime_kind in stored data', () => {
    setup()
    repo.create({ id: 'ws-1', name: 'Demo', runtime: { kind: 'windows' }, path: 'C:\\d' })
    connection.prepare('UPDATE workspaces SET runtime_kind = ? WHERE id = ?').run('plan9', 'ws-1')

    const result = repo.getById('ws-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('returns VALIDATION_FAILED for a non-ISO timestamp in stored data', () => {
    setup()
    repo.create({ id: 'ws-1', name: 'Demo', runtime: { kind: 'windows' }, path: 'C:\\d' })
    connection
      .prepare('UPDATE workspaces SET created_at = ? WHERE id = ?')
      .run('2026-09-09 10:00:00', 'ws-1')

    const result = repo.getById('ws-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })
})
