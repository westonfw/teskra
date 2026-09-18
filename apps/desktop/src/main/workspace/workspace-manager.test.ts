import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntimeRef } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import { createWorkspaceRepository } from '../db/repositories'
import { createTeskraPaths } from '../paths'
import { createCredentialStore, type CredentialCipher } from '../security/credential-store'
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
  rmSync(tempHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
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

describe('WorkspaceManager.setTrustLevel (TASK-118)', () => {
  it('creates workspaces as restricted by default and flips the level', () => {
    const created = manager.create({
      name: 'Demo',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: '/home/user/demo',
    })
    if (!created.ok) throw new Error('create should succeed')
    expect(created.data.trustLevel).toBe('restricted')

    const trusted = manager.setTrustLevel(created.data.id, 'trusted')
    expect(trusted.ok).toBe(true)
    if (!trusted.ok) return
    expect(trusted.data.trustLevel).toBe('trusted')

    const restricted = manager.setTrustLevel(created.data.id, 'restricted')
    expect(restricted.ok).toBe(true)
    if (!restricted.ok) return
    expect(restricted.data.trustLevel).toBe('restricted')
  })

  it('reports WORKSPACE_NOT_FOUND for an unknown id', () => {
    const result = manager.setTrustLevel('nope', 'trusted')
    expect(result).toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } })
  })
})

/** Deterministic stand-in for safeStorage: reversibly "encrypts" via base64. */
function mockCipher(available = true): CredentialCipher {
  return {
    isAvailable: () => available,
    encrypt: (plaintext) => `enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
    decrypt: (ciphertext) =>
      Buffer.from(ciphertext.slice('enc:'.length), 'base64').toString('utf8'),
  }
}

describe('WorkspaceManager env secret diversion (TASK-088)', () => {
  function managerWithCredentials(available = true): {
    manager: WorkspaceManager
    store: ReturnType<typeof createCredentialStore>
  } {
    const paths = createTeskraPaths()
    const store = createCredentialStore({ paths, cipher: mockCipher(available) })
    return {
      store,
      manager: createWorkspaceManager(createWorkspaceRepository(connection), {
        now: () => `2026-09-09T10:00:${String(tick++).padStart(2, '0')}.000Z`,
        credentials: store,
      }),
    }
  }

  function rawEnvJson(id: string): string | null {
    const row = connection.prepare('SELECT env_json FROM workspaces WHERE id = ?').get(id) as
      { env_json: string | null } | undefined
    return row?.env_json ?? null
  }

  it('diverts secret-shaped values to the Credential Store; env_json keeps only the ref', () => {
    const { manager: secureManager, store } = managerWithCredentials()
    const created = secureManager.create({
      name: 'Secrets',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: '/home/user/secrets',
      env: {
        PLAIN_VAR: 'visible',
        OPENAI_API_KEY: 'sk-test-secret-123',
        MY_TOKEN: 'not-a-known-shape-but-secret-key-name',
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    // Acceptance: 敏感 env 不出现在 workspaces.env_json（直接读 DB 断言）。
    const envJson = rawEnvJson(created.data.id)
    expect(envJson).not.toBeNull()
    expect(envJson).not.toContain('sk-test-secret-123')
    expect(envJson).not.toContain('not-a-known-shape-but-secret-key-name')
    expect(envJson).toContain('visible')

    const ref = `workspace/${created.data.id}/OPENAI_API_KEY`
    expect(created.data.env).toEqual({
      PLAIN_VAR: 'visible',
      OPENAI_API_KEY: { secretRef: ref },
      MY_TOKEN: { secretRef: `workspace/${created.data.id}/MY_TOKEN` },
    })

    // The value round-trips through the store; the ciphertext file holds no plaintext.
    expect(store.get(ref)).toEqual({ ok: true, data: 'sk-test-secret-123' })
    const onDisk = readFileSync(createTeskraPaths().credentials(), 'utf8')
    expect(onDisk).not.toContain('sk-test-secret-123')
  })

  it('fails explicitly when encryption is unavailable — nothing is persisted', () => {
    const { manager: degradedManager } = managerWithCredentials(false)
    const created = degradedManager.create({
      name: 'Secrets',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: '/home/user/secrets',
      env: { OPENAI_API_KEY: 'sk-test-secret-123' },
    })
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
    expect(created.error.retryable).toBe(false)

    // No workspace row, no credentials file, no plaintext anywhere on disk.
    expect(degradedManager.listRecent(10)).toEqual({ ok: true, data: [] })
    expect(existsSync(createTeskraPaths().credentials())).toBe(false)
  })

  it('still accepts non-sensitive env without a Credential Store', () => {
    const created = manager.create({
      name: 'Plain',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: '/home/user/plain',
      env: { PLAIN_VAR: 'visible' },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.env).toEqual({ PLAIN_VAR: 'visible' })
  })

  it('remove() deletes the workspace Credential Store entries (P2-5)', () => {
    const { manager: secureManager, store } = managerWithCredentials()
    const first = secureManager.create({
      name: 'One',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: '/home/user/one',
      env: { OPENAI_API_KEY: 'sk-test-secret-123' },
    })
    const second = secureManager.create({
      name: 'Two',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: '/home/user/two',
      env: { OPENAI_API_KEY: 'sk-test-secret-456' },
    })
    if (!first.ok || !second.ok) throw new Error('create should succeed')

    expect(secureManager.remove(first.data.id)).toEqual({ ok: true, data: true })
    // Only the removed workspace's entries are gone; the survivor's stay.
    expect(store.list()).toEqual({
      ok: true,
      data: [`workspace/${second.data.id}/OPENAI_API_KEY`],
    })
    // Removing an unknown id touches nothing.
    expect(secureManager.remove('no-such-id')).toEqual({ ok: true, data: false })
    expect(store.list()).toEqual({
      ok: true,
      data: [`workspace/${second.data.id}/OPENAI_API_KEY`],
    })
  })

  it('rolls back partially written secrets when a later diversion write fails (P2-5)', () => {
    const paths = createTeskraPaths()
    let encryptions = 0
    const flakyCipher: CredentialCipher = {
      isAvailable: () => true,
      encrypt: (plaintext) => {
        encryptions += 1
        if (encryptions === 2) throw new Error('cipher blew up mid-write')
        return `enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`
      },
      decrypt: (ciphertext) =>
        Buffer.from(ciphertext.slice('enc:'.length), 'base64').toString('utf8'),
    }
    const store = createCredentialStore({ paths, cipher: flakyCipher })
    const flakyManager = createWorkspaceManager(createWorkspaceRepository(connection), {
      now: () => `2026-09-09T10:00:${String(tick++).padStart(2, '0')}.000Z`,
      credentials: store,
    })

    const created = flakyManager.create({
      name: 'Flaky',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
      path: '/home/user/flaky',
      env: { FIRST_API_KEY: 'sk-test-secret-123', SECOND_API_KEY: 'sk-test-secret-456' },
    })
    expect(created.ok).toBe(false)
    // The first secret was written before the failure; the rollback removed
    // it, so no half-written credentials survive.
    expect(store.list()).toEqual({ ok: true, data: [] })
    expect(flakyManager.listRecent(10)).toEqual({ ok: true, data: [] })
  })

  it('drops diverted secrets when the workspace insert itself fails (P2-5)', () => {
    const { manager: secureManager, store } = managerWithCredentials()
    connection
      .prepare(
        `CREATE TRIGGER fail_workspace_insert BEFORE INSERT ON workspaces
         BEGIN SELECT RAISE(FAIL, 'insert blocked by test'); END`,
      )
      .run()
    try {
      const created = secureManager.create({
        name: 'Doomed',
        runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' },
        path: '/home/user/doomed',
        env: { OPENAI_API_KEY: 'sk-test-secret-123' },
      })
      expect(created.ok).toBe(false)
      // The INSERT failed after the secret was diverted; the orphaned
      // credential must not survive.
      expect(store.list()).toEqual({ ok: true, data: [] })
    } finally {
      connection.prepare('DROP TRIGGER fail_workspace_insert').run()
    }
  })
})
