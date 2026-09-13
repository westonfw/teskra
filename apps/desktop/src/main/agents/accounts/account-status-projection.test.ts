import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  AgentAccountProfile,
  AgentFailureClassification,
  AgentRun,
  IpcResult,
  WorkbenchEvents,
} from '@teskra/contracts'

import { createConfigService } from '../../config/config-service'
import { migrateDatabase } from '../../db/migrations'
import {
  createAccountProfileRepository,
  createAgentRunRepository,
  createWorkspaceRepository,
  type AccountProfileRepository,
  type AgentRunRepository,
} from '../../db/repositories'
import { createEventBus, type EventBus } from '../../events/event-bus'
import { createTeskraPaths } from '../../paths'
import { createAccountProfileManager } from './account-profile-manager'
import {
  createAccountProfileStatusService,
  type AccountProfileStatusService,
} from './account-profile-status-service'

/**
 * TASK-106 (§18 / §18.0) — Account Status Projection: terminal Run outcomes
 * projected onto account profile status (persisted + events), restart
 * read-back, and the lazy-degrade / sweep recovery of expired `limited`
 * profiles. No timers are involved anywhere — the triggers are the EventBus
 * (projection), reads (lazy), and startup / Settings → Accounts (sweep).
 */

const NOW = '2026-09-12T12:00:00.000Z'
const RESET_AT = '2026-10-01T00:00:00.000Z'
const UBUNTU = { kind: 'wsl', distro: 'ubuntu-22.04' } as const

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

interface Fixture {
  readonly databaseFile: string
  readonly connection: Database.Database
  readonly profiles: AccountProfileRepository
  readonly runs: AgentRunRepository
  readonly events: EventBus<WorkbenchEvents>
  readonly service: AccountProfileStatusService
}

function setup(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-task106-'))
  directories.push(directory)
  const databaseFile = join(directory, 'teskra.db')
  const connection = new Database(databaseFile)
  connection.pragma('foreign_keys = ON')
  requireOk(migrateDatabase(connection))
  databases.push(connection)

  const profiles = createAccountProfileRepository(connection)
  const runs = createAgentRunRepository(connection)
  const workspaces = createWorkspaceRepository(connection)
  requireOk(
    workspaces.create(
      { id: 'workspace-1', name: 'Demo', runtime: UBUNTU, path: '/repo' },
      '2026-09-12T00:00:00.000Z',
    ),
  )
  const events = createEventBus<WorkbenchEvents>()
  const service = createAccountProfileStatusService({
    profiles,
    runs,
    events,
    now: () => NOW,
  })
  return { databaseFile, connection, profiles, runs, events, service }
}

function seedProfile(
  fixture: Fixture,
  id: string,
  options: { status?: AgentAccountProfile['status']; limitedUntil?: string } = {},
): AgentAccountProfile {
  const profile = requireOk(
    fixture.profiles.create({
      id,
      agentId: 'codex',
      name: id,
      authType: 'subscription',
      runtime: UBUNTU,
      configHome: `/home/u/.teskra/agent-profiles/codex/${id}`,
      status: options.status ?? 'ready',
    }),
  )
  if (options.limitedUntil !== undefined) {
    return requireOk(
      fixture.profiles.setStatus(id, {
        status: options.status ?? 'limited',
        limitedUntil: options.limitedUntil,
      }),
    ) as AgentAccountProfile
  }
  return profile
}

function seedRun(
  fixture: Fixture,
  id: string,
  options: {
    status: AgentRun['status']
    accountProfileId?: string
    failureClassification?: AgentFailureClassification
  },
): AgentRun {
  return requireOk(
    fixture.runs.create({
      id,
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: `/runs/${id}`,
      status: options.status,
      ...(options.accountProfileId === undefined
        ? {}
        : { accountProfileId: options.accountProfileId }),
      ...(options.failureClassification === undefined
        ? {}
        : { failureClassification: options.failureClassification }),
    }),
  )
}

function profileOf(fixture: Fixture, id: string): AgentAccountProfile {
  const profile = requireOk(fixture.profiles.getById(id))
  if (profile === null) throw new Error(`profile ${id} missing`)
  return profile
}

type Emission =
  | { readonly kind: 'status_changed'; previous: string; next: string; limitedUntil?: string }
  | { readonly kind: 'limited'; limitedUntil?: string }
  | { readonly kind: 'login_required' }

function recordEmissions(fixture: Fixture, profileId: string): Emission[] {
  const emissions: Emission[] = []
  fixture.events.subscribe('account.status_changed', (payload) => {
    if (payload.profileId === profileId) {
      emissions.push({
        kind: 'status_changed',
        previous: payload.previousStatus,
        next: payload.status,
      })
    }
  })
  fixture.events.subscribe('account.limited', (payload) => {
    if (payload.profileId === profileId) {
      emissions.push({
        kind: 'limited',
        ...(payload.limitedUntil === undefined ? {} : { limitedUntil: payload.limitedUntil }),
      })
    }
  })
  fixture.events.subscribe('account.login_required', (payload) => {
    if (payload.profileId === profileId) {
      emissions.push({ kind: 'login_required' })
    }
  })
  return emissions
}

describe('Run outcome projection (TASK-106, §18)', () => {
  it('rate-limited failure → limited + limitedUntil from resetAt, with events, persisted across restart', () => {
    const fixture = setup()
    seedProfile(fixture, 'acct-1')
    seedRun(fixture, 'run-1', {
      status: 'failed',
      accountProfileId: 'acct-1',
      failureClassification: { kind: 'rate-limited', resetAt: RESET_AT, retryable: true },
    })
    const emissions = recordEmissions(fixture, 'acct-1')

    requireOk(fixture.service.projectRunOutcome('run-1'))

    const profile = profileOf(fixture, 'acct-1')
    expect(profile.status).toBe('limited')
    expect(profile.limitedUntil).toBe(RESET_AT)
    expect(profile.lastUsedAt).toBe(NOW)
    expect(profile.lastFailureAt).toBe(NOW)
    expect(emissions).toEqual([
      { kind: 'status_changed', previous: 'ready', next: 'limited' },
      { kind: 'limited', limitedUntil: RESET_AT },
    ])

    // Restart: a fresh connection over the same file must read the same row.
    fixture.connection.close()
    const reopened = new Database(fixture.databaseFile, { readonly: true })
    try {
      const restored = requireOk(createAccountProfileRepository(reopened).getById('acct-1'))
      expect(restored?.status).toBe('limited')
      expect(restored?.limitedUntil).toBe(RESET_AT)
      expect(restored?.lastFailureAt).toBe(NOW)
    } finally {
      reopened.close()
    }
  })

  it('authentication-required failure → login-required with the dedicated event', () => {
    const fixture = setup()
    seedProfile(fixture, 'acct-1')
    seedRun(fixture, 'run-1', {
      status: 'failed',
      accountProfileId: 'acct-1',
      failureClassification: { kind: 'authentication-required', retryable: false },
    })
    const emissions = recordEmissions(fixture, 'acct-1')

    requireOk(fixture.service.projectRunOutcome('run-1'))

    expect(profileOf(fixture, 'acct-1').status).toBe('login-required')
    expect(emissions).toEqual([
      { kind: 'status_changed', previous: 'ready', next: 'login-required' },
      { kind: 'login_required' },
    ])
  })

  it('authentication-expired failure → expired', () => {
    const fixture = setup()
    seedProfile(fixture, 'acct-1')
    seedRun(fixture, 'run-1', {
      status: 'failed',
      accountProfileId: 'acct-1',
      failureClassification: { kind: 'authentication-expired', retryable: false },
    })
    const emissions = recordEmissions(fixture, 'acct-1')

    requireOk(fixture.service.projectRunOutcome('run-1'))

    expect(profileOf(fixture, 'acct-1').status).toBe('expired')
    expect(emissions).toEqual([{ kind: 'status_changed', previous: 'ready', next: 'expired' }])
  })

  it('successful run → ready + lastSuccessfulAt, clearing a stale limitedUntil (§18.0: only a real success writes ready)', () => {
    const fixture = setup()
    seedProfile(fixture, 'acct-1', { status: 'limited', limitedUntil: RESET_AT })
    seedRun(fixture, 'run-1', { status: 'completed', accountProfileId: 'acct-1' })
    const emissions = recordEmissions(fixture, 'acct-1')

    requireOk(fixture.service.projectRunOutcome('run-1'))

    const profile = profileOf(fixture, 'acct-1')
    expect(profile.status).toBe('ready')
    expect(profile.limitedUntil).toBeUndefined()
    expect(profile.lastUsedAt).toBe(NOW)
    expect(profile.lastSuccessfulAt).toBe(NOW)
    expect(emissions).toEqual([{ kind: 'status_changed', previous: 'limited', next: 'ready' }])
  })

  it('account-agnostic failure kinds move only the health timestamps — status and events untouched', () => {
    const fixture = setup()
    seedProfile(fixture, 'acct-1')
    seedRun(fixture, 'run-1', {
      status: 'failed',
      accountProfileId: 'acct-1',
      failureClassification: { kind: 'network', retryable: true },
    })
    seedRun(fixture, 'run-2', { status: 'failed', accountProfileId: 'acct-1' })
    const emissions = recordEmissions(fixture, 'acct-1')

    requireOk(fixture.service.projectRunOutcome('run-1'))
    requireOk(fixture.service.projectRunOutcome('run-2'))

    const profile = profileOf(fixture, 'acct-1')
    expect(profile.status).toBe('ready')
    expect(profile.lastFailureAt).toBe(NOW)
    expect(profile.lastUsedAt).toBe(NOW)
    expect(profile.lastSuccessfulAt).toBeUndefined()
    expect(emissions).toEqual([])
  })

  it('legacy runs (no account profile) and non-terminal runs project nothing', () => {
    const fixture = setup()
    seedRun(fixture, 'run-legacy', { status: 'failed' })
    seedRun(fixture, 'run-running', { status: 'running', accountProfileId: 'acct-missing' })
    let emissions = 0
    fixture.events.subscribe('account.status_changed', () => {
      emissions += 1
    })

    requireOk(fixture.service.projectRunOutcome('run-legacy'))
    requireOk(fixture.service.projectRunOutcome('run-running'))
    requireOk(fixture.service.projectRunOutcome('run-missing'))

    expect(emissions).toBe(0)
  })

  it('start() projects from the EventBus; dispose() detaches the projection', () => {
    const fixture = setup()
    seedProfile(fixture, 'acct-1')
    seedRun(fixture, 'run-1', {
      status: 'failed',
      accountProfileId: 'acct-1',
      failureClassification: { kind: 'authentication-expired', retryable: false },
    })
    seedRun(fixture, 'run-2', { status: 'completed', accountProfileId: 'acct-1' })
    const error = { code: 'UNKNOWN' as const, message: 'x', retryable: true }

    fixture.service.start()
    fixture.service.start() // idempotent
    fixture.events.emit('agent.failed', { runId: 'run-1', error })
    expect(profileOf(fixture, 'acct-1').status).toBe('expired')

    fixture.service.dispose()
    fixture.events.emit('agent.completed', { runId: 'run-2', exitCode: 0 })
    expect(profileOf(fixture, 'acct-1').status).toBe('expired')
  })
})

describe('§18.0 lazy degrade through the AccountProfileManager read paths', () => {
  function setupManager(fixture: Fixture) {
    const directory = directories[directories.length - 1]
    if (directory === undefined) throw new Error('expected fixture directory')
    const paths = createTeskraPaths({ TESKRA_HOME: join(directory, 'data') })
    const workspaces = createWorkspaceRepository(fixture.connection)
    const config = createConfigService({ paths, workspaces })
    return createAccountProfileManager({
      profiles: fixture.profiles,
      runs: fixture.runs,
      registry: { has: () => true },
      paths,
      config,
      events: fixture.events,
      status: fixture.service,
    })
  }

  it('list() degrades an expired limited row to unknown and clears limitedUntil in the database', async () => {
    const fixture = setup()
    const manager = setupManager(fixture)
    seedProfile(fixture, 'acct-expired', {
      status: 'limited',
      limitedUntil: '2026-09-12T11:00:00.000Z',
    })
    seedProfile(fixture, 'acct-active', { status: 'limited', limitedUntil: RESET_AT })

    const listed = requireOk(await manager.list())
    const expired = listed.find((profile) => profile.id === 'acct-expired')
    const active = listed.find((profile) => profile.id === 'acct-active')
    expect(expired?.status).toBe('unknown')
    expect(expired?.limitedUntil).toBeUndefined()
    expect(active?.status).toBe('limited')
    expect(active?.limitedUntil).toBe(RESET_AT)

    // The degradation is persisted — and status filtering stays truthful.
    const persisted = profileOf(fixture, 'acct-expired')
    expect(persisted.status).toBe('unknown')
    expect(persisted.limitedUntil).toBeUndefined()
    const limitedOnly = requireOk(await manager.list({ status: 'limited' }))
    expect(limitedOnly.map((profile) => profile.id)).toEqual(['acct-active'])
  })

  it('get() degrades the single row it read, never to ready', async () => {
    const fixture = setup()
    const manager = setupManager(fixture)
    seedProfile(fixture, 'acct-expired', {
      status: 'limited',
      limitedUntil: '2026-09-12T11:00:00.000Z',
    })

    const fetched = requireOk(await manager.get('acct-expired'))
    expect(fetched?.status).toBe('unknown')
    expect(profileOf(fixture, 'acct-expired').status).toBe('unknown')
  })

  it('batch sweep is the startup / Settings trigger and degrades everything expired at once', async () => {
    const fixture = setup()
    seedProfile(fixture, 'acct-1', { status: 'limited', limitedUntil: '2026-09-12T10:00:00.000Z' })
    seedProfile(fixture, 'acct-2', { status: 'limited', limitedUntil: '2026-09-12T11:00:00.000Z' })
    seedProfile(fixture, 'acct-3', { status: 'limited', limitedUntil: RESET_AT })

    const swept = await fixture.service.sweepExpiredLimited()
    expect(swept).toEqual({ ok: true, data: 2 })
    expect(profileOf(fixture, 'acct-1').status).toBe('unknown')
    expect(profileOf(fixture, 'acct-2').status).toBe('unknown')
    expect(profileOf(fixture, 'acct-3').status).toBe('limited')
  })
})
