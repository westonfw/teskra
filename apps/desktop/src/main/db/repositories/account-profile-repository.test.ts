import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import { ISO_UTC_PATTERN } from './common'
import {
  createAccountProfileRepository,
  type AccountProfileRepository,
  type CreateAccountProfileInput,
} from './account-profile-repository'

let connection: Database.Database
let repo: AccountProfileRepository

function setup() {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
  repo = createAccountProfileRepository(connection)
}

afterEach(() => {
  connection.close()
})

function input(overrides: Partial<CreateAccountProfileInput> = {}): CreateAccountProfileInput {
  return {
    id: 'acct-1',
    agentId: 'codex',
    name: 'Codex Personal',
    authType: 'subscription',
    runtime: { kind: 'wsl', distro: 'Ubuntu-22.04' },
    configHome: '/home/weston/.teskra/agent-profiles/codex/personal',
    ...overrides,
  }
}

describe('AccountProfileRepository (TASK-096)', () => {
  it('creates and reads back a profile with all fields mapped', () => {
    setup()
    const created = repo.create(
      input({
        description: 'personal subscription',
        maxConcurrentRuns: 1,
        status: 'ready',
      }),
      '2026-09-12T08:00:00.000Z',
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data).toMatchObject({
      id: 'acct-1',
      agentId: 'codex',
      name: 'Codex Personal',
      description: 'personal subscription',
      authType: 'subscription',
      runtime: { kind: 'wsl', distro: 'ubuntu-22.04' },
      configHome: '/home/weston/.teskra/agent-profiles/codex/personal',
      maxConcurrentRuns: 1,
      status: 'ready',
      enabled: true,
    })
    expect(created.data.createdAt).toBe('2026-09-12T08:00:00.000Z')
    expect(created.data.updatedAt).toBe('2026-09-12T08:00:00.000Z')

    const fetched = repo.getById('acct-1')
    expect(fetched).toEqual(created)
  })

  it('defaults status to unknown and enabled to true', () => {
    setup()
    const created = repo.create(input())
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.status).toBe('unknown')
    expect(created.data.enabled).toBe(true)
  })

  it('lowercases wsl_distro on write', () => {
    setup()
    const created = repo.create(input({ runtime: { kind: 'wsl', distro: 'Ubuntu-22.04' } }))
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.runtime).toEqual({ kind: 'wsl', distro: 'ubuntu-22.04' })
    const raw = connection
      .prepare('SELECT wsl_distro FROM agent_account_profiles WHERE id = ?')
      .get('acct-1') as { wsl_distro: string }
    expect(raw.wsl_distro).toBe('ubuntu-22.04')
  })

  it('stores a windows runtime with a NULL wsl_distro', () => {
    setup()
    const created = repo.create(
      input({
        runtime: { kind: 'windows' },
        configHome: 'C:\\Users\\weston\\.teskra\\agent-profiles\\codex\\personal',
      }),
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.runtime).toEqual({ kind: 'windows' })
  })

  it('returns null for an unknown id', () => {
    setup()
    expect(repo.getById('missing')).toEqual({ ok: true, data: null })
  })

  it('maps the per-runtime config_home unique index violation to CONFLICT', () => {
    setup()
    expect(repo.create(input()).ok).toBe(true)
    const duplicate = repo.create(input({ id: 'acct-2', name: 'Other' }))
    expect(duplicate.ok).toBe(false)
    if (duplicate.ok) return
    expect(duplicate.error.code).toBe('CONFLICT')
  })

  it('allows the same configHome in a different runtime (per-runtime uniqueness)', () => {
    setup()
    expect(repo.create(input()).ok).toBe(true)
    const otherRuntime = repo.create(
      input({ id: 'acct-2', runtime: { kind: 'wsl', distro: 'Debian' } }),
    )
    expect(otherRuntime.ok).toBe(true)
  })

  it('treats distro case as identical for the unique index', () => {
    setup()
    expect(repo.create(input()).ok).toBe(true)
    const duplicate = repo.create(
      input({ id: 'acct-2', runtime: { kind: 'wsl', distro: 'UBUNTU-22.04' } }),
    )
    expect(duplicate.ok).toBe(false)
    if (duplicate.ok) return
    expect(duplicate.error.code).toBe('CONFLICT')
  })

  it('updates mutable columns and clears nullable ones with null', () => {
    setup()
    repo.create(input({ description: 'keep?', maxConcurrentRuns: 2 }))
    const updated = repo.update(
      'acct-1',
      { name: 'Renamed', description: null, maxConcurrentRuns: null },
      '2026-09-12T09:00:00.000Z',
    )
    expect(updated.ok).toBe(true)
    if (!updated.ok || updated.data === null) return
    expect(updated.data.name).toBe('Renamed')
    expect(updated.data.description).toBeUndefined()
    expect(updated.data.maxConcurrentRuns).toBeUndefined()
    expect(updated.data.updatedAt).toBe('2026-09-12T09:00:00.000Z')
  })

  it('returns null when updating a missing profile', () => {
    setup()
    expect(repo.update('missing', { name: 'x' })).toEqual({ ok: true, data: null })
  })

  it('disable() flips enabled to false and setEnabled() flips it back', () => {
    setup()
    repo.create(input())
    const disabled = repo.disable('acct-1')
    expect(disabled.ok).toBe(true)
    if (!disabled.ok || disabled.data === null) return
    expect(disabled.data.enabled).toBe(false)
    const raw = connection
      .prepare('SELECT enabled FROM agent_account_profiles WHERE id = ?')
      .get('acct-1') as { enabled: number }
    expect(raw.enabled).toBe(0)

    const enabled = repo.setEnabled('acct-1', true)
    expect(enabled.ok).toBe(true)
    if (!enabled.ok || enabled.data === null) return
    expect(enabled.data.enabled).toBe(true)
  })

  it('setStatus updates status and limitedUntil, and clears limitedUntil with null', () => {
    setup()
    repo.create(input())
    const limited = repo.setStatus('acct-1', {
      status: 'limited',
      limitedUntil: '2026-09-13T00:00:00.000Z',
    })
    expect(limited.ok).toBe(true)
    if (!limited.ok || limited.data === null) return
    expect(limited.data.status).toBe('limited')
    expect(limited.data.limitedUntil).toBe('2026-09-13T00:00:00.000Z')

    const cleared = repo.setStatus('acct-1', { status: 'unknown', limitedUntil: null })
    expect(cleared.ok).toBe(true)
    if (!cleared.ok || cleared.data === null) return
    expect(cleared.data.status).toBe('unknown')
    expect(cleared.data.limitedUntil).toBeUndefined()
  })

  it('lists profiles filtered by agentId, status, and enabled', () => {
    setup()
    repo.create(input())
    repo.create(
      input({
        id: 'acct-2',
        agentId: 'claude',
        configHome: '/home/weston/.teskra/agent-profiles/claude/work',
      }),
    )
    repo.create(
      input({
        id: 'acct-3',
        agentId: 'codex',
        configHome: '/home/weston/.teskra/agent-profiles/codex/work',
        status: 'ready',
        enabled: false,
      }),
    )

    const all = repo.list()
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.data.map((profile) => profile.id)).toEqual(['acct-1', 'acct-2', 'acct-3'])

    const byAgent = repo.list({ agentId: 'codex' })
    expect(byAgent.ok && byAgent.data.map((profile) => profile.id)).toEqual(['acct-1', 'acct-3'])

    const byStatus = repo.list({ status: 'ready' })
    expect(byStatus.ok && byStatus.data.map((profile) => profile.id)).toEqual(['acct-3'])

    const byEnabled = repo.list({ enabled: false })
    expect(byEnabled.ok && byEnabled.data.map((profile) => profile.id)).toEqual(['acct-3'])

    const combined = repo.list({ agentId: 'codex', enabled: true })
    expect(combined.ok && combined.data.map((profile) => profile.id)).toEqual(['acct-1'])
  })

  it('hard-deletes a row (create-flow compensation path)', () => {
    setup()
    repo.create(input())
    expect(repo.delete('acct-1')).toEqual({ ok: true, data: true })
    expect(repo.getById('acct-1')).toEqual({ ok: true, data: null })
    expect(repo.delete('acct-1')).toEqual({ ok: true, data: false })
  })

  it('writes ISO-8601 UTC timestamps', () => {
    setup()
    const created = repo.create(input())
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.createdAt).toMatch(ISO_UTC_PATTERN)
    expect(created.data.updatedAt).toMatch(ISO_UTC_PATTERN)
  })
})
