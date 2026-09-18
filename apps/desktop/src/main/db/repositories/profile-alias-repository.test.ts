import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import {
  createProfileAliasRepository,
  type ProfileAliasRepository,
} from './profile-alias-repository'

let connection: Database.Database
let repo: ProfileAliasRepository

const AT = '2026-09-14T08:00:00.000Z'
const LATER = '2026-09-14T09:00:00.000Z'

function setup() {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
  repo = createProfileAliasRepository(connection)
}

afterEach(() => {
  connection.close()
})

describe('ProfileAliasRepository (TASK-111)', () => {
  it('binds and resolves an alias to a profileId', () => {
    setup()
    const bound = repo.bind(
      { agentId: 'codex', kind: 'account', alias: 'work', profileId: 'acct_codex_work' },
      AT,
    )
    expect(bound).toEqual({
      ok: true,
      data: {
        agentId: 'codex',
        kind: 'account',
        alias: 'work',
        profileId: 'acct_codex_work',
        createdAt: AT,
        updatedAt: AT,
      },
    })
    expect(repo.resolve('codex', 'account', 'work')).toEqual({
      ok: true,
      data: 'acct_codex_work',
    })
  })

  it('bind is an upsert: re-binding replaces the profileId and bumps updated_at', () => {
    setup()
    repo.bind({ agentId: 'codex', kind: 'account', alias: 'work', profileId: 'acct-1' }, AT)
    const rebound = repo.bind(
      { agentId: 'codex', kind: 'account', alias: 'work', profileId: 'acct-2' },
      LATER,
    )
    expect(rebound.ok).toBe(true)
    if (!rebound.ok) return
    expect(rebound.data.profileId).toBe('acct-2')
    expect(rebound.data.updatedAt).toBe(LATER)
    expect(repo.list()).toMatchObject({ ok: true })
    expect(repo.list({ agentId: 'codex' })).toMatchObject({ ok: true })
    const listed = repo.list()
    expect(listed.ok && listed.data.length).toBe(1)
  })

  it('keeps same-named aliases isolated per agentId and per kind', () => {
    setup()
    repo.bind({ agentId: 'codex', kind: 'account', alias: 'work', profileId: 'acct_codex' }, AT)
    repo.bind({ agentId: 'claude', kind: 'account', alias: 'work', profileId: 'acct_claude' }, AT)
    repo.bind({ agentId: 'codex', kind: 'execution', alias: 'work', profileId: 'exec_codex' }, AT)

    expect(repo.resolve('codex', 'account', 'work')).toEqual({ ok: true, data: 'acct_codex' })
    expect(repo.resolve('claude', 'account', 'work')).toEqual({ ok: true, data: 'acct_claude' })
    expect(repo.resolve('codex', 'execution', 'work')).toEqual({ ok: true, data: 'exec_codex' })
    expect(repo.resolve('kimi', 'account', 'work')).toEqual({ ok: true, data: undefined })
  })

  it('unbind removes exactly one binding and reports false when absent', () => {
    setup()
    repo.bind({ agentId: 'codex', kind: 'account', alias: 'work', profileId: 'acct_codex' }, AT)
    repo.bind({ agentId: 'codex', kind: 'execution', alias: 'work', profileId: 'exec_codex' }, AT)

    expect(repo.unbind('codex', 'account', 'work')).toEqual({ ok: true, data: true })
    expect(repo.resolve('codex', 'account', 'work')).toEqual({ ok: true, data: undefined })
    // The execution-kind binding under the same alias survives.
    expect(repo.resolve('codex', 'execution', 'work')).toEqual({ ok: true, data: 'exec_codex' })
    expect(repo.unbind('codex', 'account', 'work')).toEqual({ ok: true, data: false })
  })

  it('list filters by agentId and kind', () => {
    setup()
    repo.bind({ agentId: 'codex', kind: 'account', alias: 'work', profileId: 'acct_codex' }, AT)
    repo.bind({ agentId: 'codex', kind: 'execution', alias: 'high', profileId: 'exec_codex' }, AT)
    repo.bind({ agentId: 'claude', kind: 'account', alias: 'work', profileId: 'acct_claude' }, AT)

    const all = repo.list()
    expect(all.ok && all.data.length).toBe(3)
    const codexOnly = repo.list({ agentId: 'codex' })
    expect(codexOnly.ok && codexOnly.data.map((row) => row.alias).sort()).toEqual(['high', 'work'])
    const accountOnly = repo.list({ kind: 'account' })
    expect(accountOnly.ok && accountOnly.data.length).toBe(2)
    const codexExecution = repo.list({ agentId: 'codex', kind: 'execution' })
    expect(codexExecution).toMatchObject({ ok: true })
    expect(codexExecution.ok && codexExecution.data[0]?.profileId).toBe('exec_codex')
  })

  it('a deleted Profile leaves the binding resolvable at the repository layer (no FK cascade)', () => {
    setup()
    // No Profile row exists for acct_ghost at all: the table has no FK, so the
    // binding stores fine and resolve still returns the dangling id. Turning
    // that into an "unbound" error is the Manager's job.
    repo.bind({ agentId: 'codex', kind: 'account', alias: 'ghost', profileId: 'acct_ghost' }, AT)
    expect(repo.resolve('codex', 'account', 'ghost')).toEqual({ ok: true, data: 'acct_ghost' })
  })
})
