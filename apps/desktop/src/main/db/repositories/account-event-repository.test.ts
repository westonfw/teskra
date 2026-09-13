import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import {
  createAccountEventRepository,
  type AccountEventRepository,
  type AppendAccountEventInput,
} from './account-event-repository'

let connection: Database.Database
let repo: AccountEventRepository

function setup() {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
  repo = createAccountEventRepository(connection)
}

afterEach(() => {
  connection.close()
})

function input(overrides: Partial<AppendAccountEventInput> = {}): AppendAccountEventInput {
  return {
    profileId: 'acct-1',
    eventType: 'account.created',
    payload: { agentId: 'codex', name: 'Codex Personal' },
    ...overrides,
  }
}

describe('AccountEventRepository (TASK-116)', () => {
  it('appends and reads back an event with all fields mapped', () => {
    setup()
    const appended = repo.append(input(), '2026-09-12T08:00:00.000Z')
    expect(appended.ok).toBe(true)
    if (!appended.ok) return
    expect(appended.data).toMatchObject({
      profileId: 'acct-1',
      eventType: 'account.created',
      payload: { agentId: 'codex', name: 'Codex Personal' },
      createdAt: '2026-09-12T08:00:00.000Z',
    })
    expect(appended.data.runId).toBeUndefined()
    expect(appended.data.id).toBeGreaterThan(0)

    const listed = repo.listByProfile('acct-1')
    expect(listed).toEqual({ ok: true, data: [appended.data] })
  })

  it('round-trips nested payload JSON as text', () => {
    setup()
    const payload = {
      sourceRunId: 'run-1',
      targetRunId: 'run-2',
      from: 'acct_personal',
      to: 'acct_work',
      reason: 'rate-limit',
      nested: { resetAt: '2026-10-01T00:00:00.000Z', retryable: true },
    }
    const appended = repo.append(
      input({ eventType: 'agent.account_switched', runId: 'run-2', payload }),
    )
    expect(appended.ok).toBe(true)
    if (!appended.ok) return
    expect(appended.data.payload).toEqual(payload)
    const raw = connection
      .prepare('SELECT payload_json FROM account_events WHERE id = ?')
      .get(appended.data.id) as { payload_json: string }
    expect(typeof raw.payload_json).toBe('string')
    expect(JSON.parse(raw.payload_json)).toEqual(payload)
  })

  it('stores profile-lifecycle events without any agent_runs row (no FK anywhere)', () => {
    setup()
    // §8.1.1: account.created / login_* belong to no Run — and neither column
    // carries a FK, so even a run_id that never existed in agent_runs writes.
    const lifecycle = repo.append(input({ profileId: 'acct-gone' }))
    expect(lifecycle.ok).toBe(true)
    const danglingRun = repo.append(
      input({ eventType: 'agent.rate_limited', runId: 'run-never-existed' }),
    )
    expect(danglingRun.ok).toBe(true)
  })

  it('lists by profile newest first and honors the limit', () => {
    setup()
    for (let index = 1; index <= 5; index += 1) {
      const appended = repo.append(
        input({ eventType: `event.${String(index)}` }),
        `2026-09-12T08:00:0${String(index)}.000Z`,
      )
      expect(appended.ok).toBe(true)
    }
    const all = repo.listByProfile('acct-1')
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.data.map((event) => event.eventType)).toEqual([
      'event.5',
      'event.4',
      'event.3',
      'event.2',
      'event.1',
    ])
    const limited = repo.listByProfile('acct-1', { limit: 2 })
    expect(limited.ok).toBe(true)
    if (!limited.ok) return
    expect(limited.data.map((event) => event.eventType)).toEqual(['event.5', 'event.4'])
    expect(repo.listByProfile('acct-other')).toEqual({ ok: true, data: [] })
  })

  it('lists by type newest first and honors the limit', () => {
    setup()
    repo.append(input({ eventType: 'account.created' }), '2026-09-12T08:00:01.000Z')
    repo.append(input({ eventType: 'account.updated' }), '2026-09-12T08:00:02.000Z')
    repo.append(
      input({ eventType: 'account.created', profileId: 'acct-2' }),
      '2026-09-12T08:00:03.000Z',
    )
    const created = repo.listByType('account.created')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.map((event) => event.profileId)).toEqual(['acct-2', 'acct-1'])
    const limited = repo.listByType('account.created', { limit: 1 })
    expect(limited.ok).toBe(true)
    if (!limited.ok) return
    expect(limited.data).toHaveLength(1)
    expect(limited.data[0]?.profileId).toBe('acct-2')
    expect(repo.listByType('agent.account_switched')).toEqual({ ok: true, data: [] })
  })

  it('associates an account switch with its source and target Run ids', () => {
    setup()
    // §41 example shape: the row is keyed to the target Run while the payload
    // carries both sides of the switch.
    const appended = repo.append(
      input({
        eventType: 'agent.account_switched',
        runId: 'run-target',
        payload: {
          taskId: 'TASK-218',
          sourceRunId: 'run-source',
          targetRunId: 'run-target',
          from: 'acct_codex_personal',
          to: 'acct_codex_work',
          reason: 'rate-limit',
        },
      }),
    )
    expect(appended.ok).toBe(true)
    if (!appended.ok) return
    expect(appended.data.runId).toBe('run-target')
    expect(appended.data.payload).toMatchObject({
      sourceRunId: 'run-source',
      targetRunId: 'run-target',
    })
  })
})
