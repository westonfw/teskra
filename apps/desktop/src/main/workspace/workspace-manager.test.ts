import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntimeRef } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import { createWorkspaceRepository } from '../db/repositories'
import { createWorkspaceManager, type WorkspaceManager } from './workspace-manager'

// Tests must run on both the Linux dev machine and the Windows CI gate.
// "Native" scenarios use the runtime kind whose paths node:fs can actually
// stat on the current host; Windows-path scenarios that only make sense off
// Windows are skipped on win32.
const nativeRuntime: WorkspaceRuntimeRef =
  process.platform === 'win32' ? { kind: 'windows' } : { kind: 'wsl', distro: 'Ubuntu' }

let connection: Database.Database
let manager: WorkspaceManager
let tempHome: string
let savedTeskraHome: string | undefined
let tick: number

function makeTempDir(name: string): string {
  const dir = join(tempHome, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeEach(() => {
  // TESKRA_HOME isolation: nothing under test may touch the real data root.
  savedTeskraHome = process.env['TESKRA_HOME']
  tempHome = mkdtempSync(join(tmpdir(), 'teskra-ws-'))
  process.env['TESKRA_HOME'] = tempHome

  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)

  tick = 0
  manager = createWorkspaceManager(createWorkspaceRepository(connection), {
    now: () => `2026-09-09T10:00:${String(tick++).padStart(2, '0')}.000Z`,
  })
})

afterEach(() => {
  connection.close()
  if (savedTeskraHome === undefined) {
    delete process.env['TESKRA_HOME']
  } else {
    process.env['TESKRA_HOME'] = savedTeskraHome
  }
  rmSync(tempHome, { recursive: true, force: true })
})

describe('WorkspaceManager.create', () => {
  it('registers a validated workspace', () => {
    const created = manager.create({
      name: 'Demo',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: '/home/user/demo',
      defaultBranch: 'main',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.id).toBeTruthy()
    expect(created.data.name).toBe('Demo')
    expect(created.data.runtime).toEqual({ kind: 'wsl', distro: 'Ubuntu-24.04' })
    expect(created.data.lastOpenedAt).toBeUndefined()
  })

  it('rejects a duplicate (runtime, path) with a structured error', () => {
    const input = {
      name: 'Demo',
      runtime: { kind: 'windows' },
      path: 'C:\\dev\\demo',
    } as const
    expect(manager.create(input).ok).toBe(true)
    const duplicate = manager.create(input)
    expect(duplicate.ok).toBe(false)
    if (duplicate.ok) return
    expect(duplicate.error.code).toBe('VALIDATION_FAILED')

    const all = manager.listRecent(10)
    expect(all.ok && all.data.length).toBe(1)
  })

  it('rejects invalid drafts and unimplemented runtimes without writing', () => {
    const invalid = manager.create({
      name: 'Bad',
      runtime: { kind: 'wsl' },
      path: '/home/user/x',
    })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('VALIDATION_FAILED')

    const unsupported = manager.create({
      name: 'Remote',
      runtime: { kind: 'ssh', host: 'builder.example.com' },
      path: '/srv/repo',
    })
    expect(unsupported.ok).toBe(false)
    if (!unsupported.ok) expect(unsupported.error.code).toBe('CAPABILITY_NOT_AVAILABLE')

    expect(manager.listRecent(10)).toEqual({ ok: true, data: [] })
  })
})

describe('WorkspaceManager.open', () => {
  it('creates a workspace for an existing directory and stamps lastOpenedAt', () => {
    const dir = makeTempDir('project')
    const opened = manager.open({ runtime: nativeRuntime, path: dir })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.data.name).toBe('project')
    expect(opened.data.lastOpenedAt).toBe('2026-09-09T10:00:00.000Z')
  })

  it('returns WORKSPACE_NOT_FOUND for a missing directory', () => {
    const missing = manager.open({
      runtime: nativeRuntime,
      path: join(tempHome, 'does-not-exist'),
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error.code).toBe('WORKSPACE_NOT_FOUND')
  })

  it('returns WORKSPACE_NOT_FOUND when the path exists but is a file', () => {
    const dir = makeTempDir('parent')
    const file = join(dir, 'a-file')
    writeFileSync(file, 'x')
    const opened = manager.open({ runtime: nativeRuntime, path: file })
    expect(opened.ok).toBe(false)
    if (opened.ok) return
    expect(opened.error.code).toBe('WORKSPACE_NOT_FOUND')
  })

  it('reopening the same (runtime, path) reuses the workspace instead of duplicating it', () => {
    const dir = makeTempDir('project')
    const first = manager.open({ runtime: nativeRuntime, path: dir })
    const second = manager.open({ runtime: nativeRuntime, path: dir })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.data.id).toBe(first.data.id)
    expect(second.data.lastOpenedAt).not.toBe(first.data.lastOpenedAt)

    const all = manager.listRecent(10)
    expect(all.ok && all.data.length).toBe(1)
  })

  it.skipIf(process.platform === 'win32')(
    'treats the same path under a different distro as a different workspace',
    () => {
      const dir = makeTempDir('project')
      const a = manager.open({ runtime: { kind: 'wsl', distro: 'Ubuntu' }, path: dir })
      const b = manager.open({ runtime: { kind: 'wsl', distro: 'Debian' }, path: dir })
      expect(a.ok && b.ok).toBe(true)
      if (!a.ok || !b.ok) return
      expect(b.data.id).not.toBe(a.data.id)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'skips the existence probe for Windows paths on a non-Windows host',
    () => {
      // On the Linux dev machine a C:\ path cannot be stat'ed; open() must
      // still succeed (TASK-010's WorkspaceRuntime will own real probing).
      const opened = manager.open({ runtime: { kind: 'windows' }, path: 'C:\\dev\\unverifiable' })
      expect(opened.ok).toBe(true)
      if (!opened.ok) return
      expect(opened.data.name).toBe('unverifiable')
    },
  )
})

describe('WorkspaceManager.validate', () => {
  it('reports exists=true for an existing directory without writing', () => {
    const dir = makeTempDir('project')
    const result = manager.validate({ runtime: nativeRuntime, path: dir })
    expect(result).toEqual({ ok: true, data: { exists: true } })
    expect(manager.listRecent(10)).toEqual({ ok: true, data: [] })
  })

  it('reports exists=false for a missing directory', () => {
    const result = manager.validate({
      runtime: nativeRuntime,
      path: join(tempHome, 'nope'),
    })
    expect(result).toEqual({ ok: true, data: { exists: false } })
  })

  it.skipIf(process.platform === 'win32')(
    'reports exists=null for paths the host cannot check',
    () => {
      const result = manager.validate({ runtime: { kind: 'windows' }, path: 'C:\\dev\\demo' })
      expect(result).toEqual({ ok: true, data: { exists: null } })
    },
  )

  it('returns the domain error for invalid input', () => {
    const result = manager.validate({ runtime: { kind: 'wsl' }, path: '/home/user/x' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('WorkspaceManager.remove / listRecent', () => {
  it('removes a workspace and reports unknown ids', () => {
    const dir = makeTempDir('project')
    const opened = manager.open({ runtime: nativeRuntime, path: dir })
    if (!opened.ok) throw new Error('open should succeed')
    expect(manager.remove(opened.data.id)).toEqual({ ok: true, data: true })
    expect(manager.remove(opened.data.id)).toEqual({ ok: true, data: false })
  })

  it('lists recent workspaces, most recently opened first', () => {
    const dirA = makeTempDir('a')
    const dirB = makeTempDir('b')
    manager.open({ runtime: nativeRuntime, path: dirA })
    manager.open({ runtime: nativeRuntime, path: dirB })

    const recent = manager.listRecent(10)
    expect(recent.ok).toBe(true)
    if (!recent.ok) return
    expect(recent.data.map((ws) => ws.name)).toEqual(['b', 'a'])

    const limited = manager.listRecent(1)
    expect(limited.ok && limited.data.map((ws) => ws.name)).toEqual(['b'])
  })
})
