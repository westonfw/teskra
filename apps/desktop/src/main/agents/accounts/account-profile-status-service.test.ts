import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import type { WorkbenchEvents } from '@teskra/contracts'

import { migrateDatabase } from '../../db/migrations'
import { createAccountProfileRepository, createAgentRunRepository } from '../../db/repositories'
import { createEventBus } from '../../events/event-bus'
import {
  createAccountProfileStatusService,
  isLimitedExpired,
} from './account-profile-status-service'

let connection: Database.Database

afterEach(() => {
  connection.close()
})

function setup(now: string) {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  const profiles = createAccountProfileRepository(connection)
  const runs = createAgentRunRepository(connection)
  const events = createEventBus<WorkbenchEvents>()
  const service = createAccountProfileStatusService({
    profiles,
    runs,
    events,
    now: () => now,
  })
  return { profiles, runs, events, service }
}

function insertLimited(
  profiles: ReturnType<typeof createAccountProfileRepository>,
  id: string,
  limitedUntil?: string,
) {
  const created = profiles.create({
    id,
    agentId: 'codex',
    name: id,
    authType: 'subscription',
    runtime: { kind: 'wsl', distro: 'Ubuntu' },
    configHome: `/home/u/.teskra/agent-profiles/codex/${id}`,
    status: 'limited',
  })
  if (!created.ok) throw new Error(created.error.message)
  if (limitedUntil !== undefined) {
    const updated = profiles.setStatus(id, { status: 'limited', limitedUntil })
    if (!updated.ok) throw new Error(updated.error.message)
    if (updated.data === null) throw new Error('expected profile')
    return updated.data
  }
  return created.data
}

describe('AccountProfileStatusService (TASK-097 skeleton, §18.0)', () => {
  it('reads an expired limited profile as unknown, never as ready', () => {
    const { profiles, service } = setup('2026-09-12T12:00:00.000Z')
    const profile = insertLimited(profiles, 'acct-1', '2026-09-12T11:00:00.000Z')

    expect(service.effectiveStatus(profile)).toBe('unknown')
    expect(isLimitedExpired(profile, '2026-09-12T12:00:00.000Z')).toBe(true)
    // The stored row is untouched by the read-side view.
    const persisted = profiles.getById('acct-1')
    expect(persisted.ok && persisted.data?.status).toBe('limited')
  })

  it('keeps an unexpired limited profile limited', () => {
    const { profiles, service } = setup('2026-09-12T12:00:00.000Z')
    const profile = insertLimited(profiles, 'acct-1', '2026-09-12T13:00:00.000Z')
    expect(service.effectiveStatus(profile)).toBe('limited')
  })

  it('sweeps expired limited rows to unknown and clears limitedUntil', async () => {
    const { profiles, events, service } = setup('2026-09-12T12:00:00.000Z')
    insertLimited(profiles, 'acct-expired', '2026-09-12T11:00:00.000Z')
    insertLimited(profiles, 'acct-active', '2026-09-12T13:00:00.000Z')

    const emissions: string[] = []
    events.subscribe('account.status_changed', (payload) =>
      emissions.push(`${payload.profileId}:${payload.previousStatus}->${payload.status}`),
    )

    const swept = await service.sweepExpiredLimited()
    expect(swept).toEqual({ ok: true, data: 1 })

    const expired = profiles.getById('acct-expired')
    expect(expired.ok && expired.data?.status).toBe('unknown')
    expect(expired.ok && expired.data?.limitedUntil).toBeUndefined()
    const active = profiles.getById('acct-active')
    expect(active.ok && active.data?.status).toBe('limited')
    expect(emissions).toEqual(['acct-expired:limited->unknown'])
  })
})
