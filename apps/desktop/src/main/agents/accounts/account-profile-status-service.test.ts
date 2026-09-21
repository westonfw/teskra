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

const NOW = '2026-09-12T12:00:00.000Z'
/** NOW - 2h: older than ACCOUNT_LIMITED_DEFAULT_DURATION_MS (1h). */
const STALE_FAILURE = '2026-09-12T10:00:00.000Z'
/** NOW - 30min: within the default window. */
const RECENT_FAILURE = '2026-09-12T11:30:00.000Z'

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

  it('treats a limited row without limitedUntil as expired once lastFailureAt passes the default window (§18.0, P1-3)', () => {
    const { profiles, service } = setup(NOW)
    const created = insertLimited(profiles, 'acct-legacy')
    const stale = profiles.setStatus('acct-legacy', {
      status: 'limited',
      lastFailureAt: STALE_FAILURE,
    })
    if (!stale.ok || stale.data === null) throw new Error('expected profile')

    expect(isLimitedExpired(stale.data, NOW)).toBe(true)
    expect(service.effectiveStatus(stale.data)).toBe('unknown')
    expect(created.lastFailureAt).toBeUndefined()
  })

  it('keeps a limited row without limitedUntil limited while lastFailureAt is inside the default window', () => {
    const { profiles, service } = setup(NOW)
    insertLimited(profiles, 'acct-recent')
    const recent = profiles.setStatus('acct-recent', {
      status: 'limited',
      lastFailureAt: RECENT_FAILURE,
    })
    if (!recent.ok || recent.data === null) throw new Error('expected profile')

    expect(isLimitedExpired(recent.data, NOW)).toBe(false)
    expect(service.effectiveStatus(recent.data)).toBe('limited')
  })

  it('degrades a limited row with neither limitedUntil nor lastFailureAt immediately', () => {
    const { profiles, service } = setup(NOW)
    const bare = insertLimited(profiles, 'acct-bare')

    expect(isLimitedExpired(bare, NOW)).toBe(true)
    expect(service.effectiveStatus(bare)).toBe('unknown')
  })

  it('prefers an explicit limitedUntil over the lastFailureAt fallback window', () => {
    const { profiles, service } = setup(NOW)
    insertLimited(profiles, 'acct-explicit')
    const explicit = profiles.setStatus('acct-explicit', {
      status: 'limited',
      limitedUntil: '2026-09-12T13:00:00.000Z',
      lastFailureAt: STALE_FAILURE,
    })
    if (!explicit.ok || explicit.data === null) throw new Error('expected profile')

    expect(isLimitedExpired(explicit.data, NOW)).toBe(false)
    expect(service.effectiveStatus(explicit.data)).toBe('limited')
  })

  it('sweeps legacy limited rows without limitedUntil once the default window passed', async () => {
    const { profiles, events, service } = setup(NOW)
    insertLimited(profiles, 'acct-stale')
    const stale = profiles.setStatus('acct-stale', {
      status: 'limited',
      lastFailureAt: STALE_FAILURE,
    })
    if (!stale.ok) throw new Error(stale.error.message)
    insertLimited(profiles, 'acct-recent')
    const recent = profiles.setStatus('acct-recent', {
      status: 'limited',
      lastFailureAt: RECENT_FAILURE,
    })
    if (!recent.ok) throw new Error(recent.error.message)

    const emissions: string[] = []
    events.subscribe('account.status_changed', (payload) =>
      emissions.push(`${payload.profileId}:${payload.previousStatus}->${payload.status}`),
    )

    const swept = await service.sweepExpiredLimited()
    expect(swept).toEqual({ ok: true, data: 1 })
    const staleRow = profiles.getById('acct-stale')
    expect(staleRow.ok && staleRow.data?.status).toBe('unknown')
    const recentRow = profiles.getById('acct-recent')
    expect(recentRow.ok && recentRow.data?.status).toBe('limited')
    expect(emissions).toEqual(['acct-stale:limited->unknown'])
  })
})
