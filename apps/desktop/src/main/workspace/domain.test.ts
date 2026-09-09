import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../db/migrations'
import { createWorkspaceRepository } from '../db/repositories'
import {
  IMPLEMENTED_RUNTIME_KINDS,
  validateRuntimeRef,
  validateWorkspaceDraft,
  validateWorkspacePath,
} from './domain'

describe('validateRuntimeRef', () => {
  it('accepts a plain windows ref', () => {
    const result = validateRuntimeRef({ kind: 'windows' })
    expect(result).toEqual({ ok: true, data: { kind: 'windows' } })
  })

  it('accepts a wsl ref with a distro', () => {
    const result = validateRuntimeRef({ kind: 'wsl', distro: 'Ubuntu-24.04' })
    expect(result).toEqual({ ok: true, data: { kind: 'wsl', distro: 'Ubuntu-24.04' } })
  })

  it('rejects a wsl ref without a distro', () => {
    const result = validateRuntimeRef({ kind: 'wsl' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects a windows ref carrying distro/host/containerId', () => {
    for (const extra of [{ distro: 'x' }, { host: 'h' }, { containerId: 'c' }]) {
      const result = validateRuntimeRef({ kind: 'windows', ...extra })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('rejects ssh and container with a structured CAPABILITY_NOT_AVAILABLE error', () => {
    for (const kind of ['ssh', 'container'] as const) {
      const result = validateRuntimeRef({ kind })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
      // Structured error, no throw; the public shape carries no detail/cause.
      expect(result.error).not.toHaveProperty('detail')
      expect(result.error).not.toHaveProperty('cause')
    }
  })

  it('rejects malformed candidates without throwing', () => {
    for (const candidate of [null, 42, {}, { kind: 'plan9' }, { kind: 'wsl', extra: 1 }]) {
      const result = validateRuntimeRef(candidate)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe('VALIDATION_FAILED')
    }
  })
})

describe('validateWorkspacePath', () => {
  it('accepts drive-letter and UNC Windows paths', () => {
    for (const path of ['C:\\dev\\demo', 'D:/work', '\\\\server\\share\\repo']) {
      const result = validateWorkspacePath({ kind: 'windows' }, path)
      expect(result).toEqual({ ok: true, data: path })
    }
  })

  it('rejects relative or POSIX-shaped Windows paths', () => {
    for (const path of ['dev\\demo', '.', '/home/user/repo', 'C:']) {
      const result = validateWorkspacePath({ kind: 'windows' }, path)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('accepts POSIX-absolute WSL paths', () => {
    const result = validateWorkspacePath({ kind: 'wsl', distro: 'Ubuntu' }, '/home/user/repo')
    expect(result).toEqual({ ok: true, data: '/home/user/repo' })
  })

  it('rejects relative or Windows-shaped WSL paths', () => {
    for (const path of ['home/user', 'C:\\dev', '\\wsl$\\Ubuntu\\home', '']) {
      const result = validateWorkspacePath({ kind: 'wsl', distro: 'Ubuntu' }, path)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe('VALIDATION_FAILED')
    }
  })
})

describe('validateWorkspaceDraft', () => {
  it('validates and normalizes a full draft', () => {
    const result = validateWorkspaceDraft({
      name: '  Demo  ',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: '/home/user/demo',
      gitRoot: '/home/user/demo',
      defaultBranch: 'main',
      env: { FOO: 'bar' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toEqual({
      name: 'Demo',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: '/home/user/demo',
      gitRoot: '/home/user/demo',
      defaultBranch: 'main',
      env: { FOO: 'bar' },
    })
  })

  it('rejects blank names and default branches', () => {
    for (const patch of [{ name: '   ' }, { defaultBranch: ' ' }]) {
      const result = validateWorkspaceDraft({
        name: 'Demo',
        runtime: { kind: 'windows' },
        path: 'C:\\dev\\demo',
        ...patch,
      })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe('VALIDATION_FAILED')
    }
  })

  it('validates gitRoot with the same per-kind path rules', () => {
    const result = validateWorkspaceDraft({
      name: 'Demo',
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      path: '/home/user/demo',
      gitRoot: 'C:\\dev\\demo',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('propagates the structured error for unimplemented runtimes', () => {
    const result = validateWorkspaceDraft({
      name: 'Remote',
      runtime: { kind: 'ssh', host: 'builder.example.com' },
      path: '/srv/repo',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
  })
})

// TASK-008 acceptance: a domain-validated workspace persists through the
// Repository (which owns the §139.1 flattening) and recent workspaces are
// readable. Full manager-level behavior lands in TASK-009.
describe('persistence through WorkspaceRepository', () => {
  let connection: Database.Database

  afterEach(() => {
    connection.close()
  })

  function setup() {
    connection = new Database(':memory:')
    connection.pragma('foreign_keys = ON')
    const migrated = migrateDatabase(connection)
    if (!migrated.ok) throw new Error(migrated.error.message)
    return createWorkspaceRepository(connection)
  }

  it('persists a validated workspace for every implemented kind', () => {
    expect(IMPLEMENTED_RUNTIME_KINDS).toEqual(['windows', 'wsl'])
    const repo = setup()
    const drafts = [
      { name: 'Win', runtime: { kind: 'windows' }, path: 'C:\\dev\\win' },
      { name: 'Wsl', runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' }, path: '/home/user/wsl' },
    ] as const
    drafts.forEach((draft, index) => {
      const validated = validateWorkspaceDraft(draft)
      expect(validated.ok).toBe(true)
      if (!validated.ok) return
      const created = repo.create({ id: `ws-${index}`, ...validated.data })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      expect(created.data.runtime).toEqual(draft.runtime)
    })
  })

  it('reads recent workspaces via listRecent', () => {
    const repo = setup()
    for (const [id, name] of [
      ['ws-a', 'A'],
      ['ws-b', 'B'],
    ] as const) {
      const draft = validateWorkspaceDraft({
        name,
        runtime: { kind: 'windows' },
        path: `C:\\dev\\${id}`,
      })
      if (!draft.ok) throw new Error('draft should validate')
      repo.create({ id, ...draft.data })
    }
    repo.update('ws-b', { lastOpenedAt: '2026-09-09T09:00:00.000Z' })

    const recent = repo.listRecent(10)
    expect(recent.ok).toBe(true)
    if (!recent.ok) return
    expect(recent.data.map((ws) => ws.id)).toEqual(['ws-b', 'ws-a'])
  })
})
