import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import { createAccountProfileRepository } from './account-profile-repository'
import {
  createExecutionProfileRepository,
  type CreateExecutionProfileInput,
  type ExecutionProfileRepository,
} from './execution-profile-repository'

let connection: Database.Database
let repo: ExecutionProfileRepository

const AT = '2026-09-14T08:00:00.000Z'

function setup() {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
  repo = createExecutionProfileRepository(connection)
}

afterEach(() => {
  connection.close()
})

function insertAccountProfile(id = 'acct-1', agentId = 'codex'): void {
  createAccountProfileRepository(connection).create(
    {
      id,
      agentId,
      name: `Account ${id}`,
      authType: 'subscription',
      runtime: { kind: 'windows' },
    },
    AT,
  )
}

function input(overrides: Partial<CreateExecutionProfileInput> = {}): CreateExecutionProfileInput {
  return {
    id: 'exec-1',
    name: 'Codex Personal High',
    agentId: 'codex',
    ...overrides,
  }
}

describe('ExecutionProfileRepository (TASK-110)', () => {
  it('creates and reads back a profile with all fields mapped', () => {
    setup()
    insertAccountProfile()
    const created = repo.create(
      input({
        accountProfileId: 'acct-1',
        model: 'gpt-5-codex',
        reasoningEffort: 'high',
        approvalMode: 'safe-auto',
      }),
      AT,
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data).toEqual({
      id: 'exec-1',
      name: 'Codex Personal High',
      agentId: 'codex',
      accountProfileId: 'acct-1',
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
      approvalMode: 'safe-auto',
      createdAt: AT,
      updatedAt: AT,
    })
    expect(repo.getById('exec-1')).toEqual(created)
  })

  it('maps nullable columns to undefined', () => {
    setup()
    const created = repo.create(input(), AT)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data).toEqual({
      id: 'exec-1',
      name: 'Codex Personal High',
      agentId: 'codex',
      createdAt: AT,
      updatedAt: AT,
    })
    expect(
      connection
        .prepare(
          'SELECT account_profile_id, model, reasoning_effort, approval_mode FROM agent_execution_profiles',
        )
        .get(),
    ).toEqual({
      account_profile_id: null,
      model: null,
      reasoning_effort: null,
      approval_mode: null,
    })
  })

  it('getById returns null for a missing profile', () => {
    setup()
    expect(repo.getById('exec-missing')).toEqual({ ok: true, data: null })
  })

  it('lists profiles, optionally filtered by agentId, in creation order', () => {
    setup()
    repo.create(input(), AT)
    repo.create(input({ id: 'exec-2', name: 'Codex Default' }), '2026-09-14T09:00:00.000Z')
    repo.create(input({ id: 'exec-3', agentId: 'claude', name: 'Claude Work' }), AT)

    const all = repo.list()
    expect(all.ok && all.data.map((profile) => profile.id)).toEqual(['exec-1', 'exec-3', 'exec-2'])
    const codexOnly = repo.list({ agentId: 'codex' })
    expect(codexOnly.ok && codexOnly.data.map((profile) => profile.id)).toEqual([
      'exec-1',
      'exec-2',
    ])
    expect(repo.list({ agentId: 'kimi' })).toEqual({ ok: true, data: [] })
  })

  it('updates fields, clears nullable ones with null, and bumps updated_at', () => {
    setup()
    insertAccountProfile()
    repo.create(
      input({
        accountProfileId: 'acct-1',
        model: 'gpt-5-codex',
        reasoningEffort: 'high',
        approvalMode: 'safe-auto',
      }),
      AT,
    )
    const later = '2026-09-14T10:00:00.000Z'
    const updated = repo.update(
      'exec-1',
      { name: 'Renamed', accountProfileId: null, model: null },
      later,
    )
    expect(updated.ok).toBe(true)
    if (!updated.ok || updated.data === null) return
    expect(updated.data).toMatchObject({
      name: 'Renamed',
      // null cleared the columns back to unset …
      model: undefined,
      // … while untouched fields survive.
      reasoningEffort: 'high',
      approvalMode: 'safe-auto',
      updatedAt: later,
    })
    expect(updated.data.accountProfileId).toBeUndefined()
  })

  it('update with an empty patch only re-reads the row', () => {
    setup()
    const created = repo.create(input(), AT)
    const updated = repo.update('exec-1', {}, '2026-09-14T10:00:00.000Z')
    expect(updated).toEqual(created)
  })

  it('update returns null for a missing profile', () => {
    setup()
    expect(repo.update('exec-missing', { name: 'X' })).toEqual({ ok: true, data: null })
  })

  it('rejects create / update referencing a missing account profile (FK)', () => {
    setup()
    const created = repo.create(input({ accountProfileId: 'acct-missing' }))
    expect(created.ok).toBe(false)
    repo.create(input(), AT)
    const updated = repo.update('exec-1', { accountProfileId: 'acct-missing' })
    expect(updated.ok).toBe(false)
  })

  it('deletes a profile and reports false for a missing one', () => {
    setup()
    repo.create(input(), AT)
    expect(repo.delete('exec-1')).toEqual({ ok: true, data: true })
    expect(repo.getById('exec-1')).toEqual({ ok: true, data: null })
    expect(repo.delete('exec-1')).toEqual({ ok: true, data: false })
  })
})
