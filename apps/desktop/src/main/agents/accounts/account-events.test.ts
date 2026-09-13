import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  AgentAccountProfile,
  IpcResult,
  WorkbenchEvents,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'

import { createConfigService } from '../../config/config-service'
import { migrateDatabase } from '../../db/migrations'
import {
  createAccountEventRepository,
  createAccountProfileRepository,
  createAgentRunRepository,
  type AccountEventRepository,
} from '../../db/repositories'
import { createEventBus, type EventBus } from '../../events/event-bus'
import { createTeskraPaths, type TeskraPaths } from '../../paths'
import type { ManagedProcess, ProcessStartRequest } from '../../process/process-manager'
import { createWorkspaceRuntime, type WorkspaceRuntime } from '../../workspace/runtime'
import { createDefaultAgentRegistry } from '../agent-registry'
import type { AgentAccountProfileAdapter } from './account-profile-adapter'
import { createAccountLoginService, type AccountLoginServiceDeps } from './account-login-service'
import { createAccountProfileManager, type AccountProfileManager } from './account-profile-manager'

/**
 * TASK-116 (§41) — the account-lifecycle audit write points: every Manager /
 * Service lifecycle transition lands in `account_events` through the injected
 * AccountEventRepository (Managers never write SQL themselves).
 */

const AT = '2026-09-13T00:00:00.000Z'
const UBUNTU: WorkspaceRuntimeRef = { kind: 'wsl', distro: 'Ubuntu-22.04' }
const EXTERNAL_HOME = '/home/u/.codex-personal'

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

interface ManagerFixture {
  readonly manager: AccountProfileManager
  readonly accountEvents: AccountEventRepository
}

function managerSetup(): ManagerFixture {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-task116-'))
  directories.push(directory)
  const paths: TeskraPaths = createTeskraPaths({ TESKRA_HOME: join(directory, 'data') })

  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  requireOk(migrateDatabase(connection))
  databases.push(connection)

  const profiles = createAccountProfileRepository(connection)
  const runs = createAgentRunRepository(connection)
  const accountEvents = createAccountEventRepository(connection)
  const registry = createDefaultAgentRegistry(false)
  if (!registry.ok) throw new Error('expected Agent Registry')
  const events = createEventBus<WorkbenchEvents>()
  const config = createConfigService({ paths })
  const createRuntime = (ref: WorkspaceRuntimeRef): IpcResult<WorkspaceRuntime> =>
    createWorkspaceRuntime(ref, { paths, hostPlatform: 'linux' })

  const manager = createAccountProfileManager({
    profiles,
    runs,
    registry: registry.data,
    paths,
    config,
    events,
    accountEvents,
    createRuntime,
  })
  return { manager, accountEvents }
}

async function createExternal(fixture: ManagerFixture): Promise<AgentAccountProfile> {
  return requireOk(
    await fixture.manager.create({
      agentId: 'codex',
      name: 'Codex Personal',
      authType: 'external',
      runtime: UBUNTU,
      configHome: EXTERNAL_HOME,
    }),
  )
}

describe('AccountProfileManager audit writes (TASK-116, §41)', () => {
  it('create writes account.created with the profile identity', async () => {
    const fixture = managerSetup()
    const profile = await createExternal(fixture)

    const created = requireOk(fixture.accountEvents.listByType('account.created'))
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      profileId: profile.id,
      eventType: 'account.created',
      payload: { agentId: 'codex', name: 'Codex Personal', authType: 'external' },
    })
    expect(created[0]?.runId).toBeUndefined()
  })

  it('update writes account.updated with the touched field names', async () => {
    const fixture = managerSetup()
    const profile = await createExternal(fixture)

    requireOk(await fixture.manager.update(profile.id, { name: 'Renamed' }))

    const updated = requireOk(fixture.accountEvents.listByType('account.updated'))
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({
      profileId: profile.id,
      payload: { agentId: 'codex', fields: ['name'] },
    })
  })

  it('a status transition writes account.status_changed with both states', async () => {
    const fixture = managerSetup()
    const profile = await createExternal(fixture)

    requireOk(await fixture.manager.update(profile.id, { status: 'ready' }))

    const changes = requireOk(fixture.accountEvents.listByType('account.status_changed'))
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      profileId: profile.id,
      payload: { agentId: 'codex', status: 'ready', previousStatus: 'unknown' },
    })
  })

  it('remove (soft disable) and enable write account.updated with the enabled flag', async () => {
    const fixture = managerSetup()
    const profile = await createExternal(fixture)

    requireOk(await fixture.manager.remove(profile.id))
    requireOk(await fixture.manager.enable(profile.id))

    const updated = requireOk(fixture.accountEvents.listByType('account.updated'))
    // Newest first: enable, then disable.
    expect(updated.map((event) => event.payload)).toEqual([
      { agentId: 'codex', enabled: true },
      { agentId: 'codex', enabled: false },
    ])
  })
})

// ------------------------------------------------------------------
// AccountLoginService (§24 / §41): login_started + login_verified
// ------------------------------------------------------------------

const LOGIN_PROFILE: AgentAccountProfile = {
  id: 'acct-1',
  agentId: 'codex',
  name: 'Codex Personal',
  authType: 'subscription',
  runtime: UBUNTU,
  configHome: '/home/u/.teskra/agent-profiles/codex/personal',
  maxConcurrentRuns: 1,
  status: 'login-required',
  enabled: true,
  createdAt: AT,
  updatedAt: AT,
}

interface LoginFixture {
  readonly service: ReturnType<typeof createAccountLoginService>
  readonly events: EventBus<WorkbenchEvents>
  readonly accountEvents: AccountEventRepository
  readonly processIds: string[]
}

function loginSetup(
  options: { detectedStatus?: AgentAccountProfile['status'] } = {},
): LoginFixture {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  requireOk(migrateDatabase(connection))
  databases.push(connection)
  const accountEvents = createAccountEventRepository(connection)

  const row = { ...LOGIN_PROFILE }
  const profiles: AccountLoginServiceDeps['profiles'] = {
    getById: (id) => ({ ok: true, data: id === row.id ? { ...row } : null }),
    setStatus: (id, patch) => {
      if (id !== row.id) return { ok: true, data: null }
      row.status = patch.status
      return { ok: true, data: { ...row } }
    },
  }
  const detectedStatus = options.detectedStatus ?? 'ready'
  const adapter: AgentAccountProfileAdapter = {
    agentId: 'codex',
    reservedEnvKeys: ['CODEX_HOME'],
    buildRuntimeProjection: (profile) => ({
      ok: true,
      data: { env: { CODEX_HOME: profile.configHome ?? '' } },
    }),
    detectStatus: () => Promise.resolve({ ok: true, data: { status: detectedStatus } }),
    buildLoginCommand: () => ({ ok: true, data: { command: 'codex', args: ['login'] } }),
  }
  const events = createEventBus<WorkbenchEvents>()
  const processIds: string[] = []
  const processes: AccountLoginServiceDeps['processes'] = {
    start(request: ProcessStartRequest): IpcResult<ManagedProcess> {
      processIds.push(request.id)
      return { ok: true, data: { id: request.id, pid: 4242, startedAt: AT } }
    },
    write: () => ({ ok: true, data: undefined }),
    resize: () => ({ ok: true, data: undefined }),
    stop: () =>
      Promise.resolve({
        ok: true,
        data: { exit: { processId: 'x', exitCode: 0 }, stage: 'terminate' as const },
      }),
  }
  const service = createAccountLoginService({
    profiles,
    adapters: { get: (agentId) => (agentId === 'codex' ? adapter : undefined) },
    processes,
    events,
    accountEvents,
    createRuntime: (ref) => createWorkspaceRuntime(ref, { hostPlatform: 'linux' }),
    now: () => AT,
  })
  return { service, events, accountEvents, processIds }
}

async function flushMicrotasks(): Promise<void> {
  // detectAfterExit chains a promise; two ticks cover detect + audit append.
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

describe('AccountLoginService audit writes (TASK-116, §41)', () => {
  it('start writes account.login_started; a verified natural exit writes account.login_verified', async () => {
    const fixture = loginSetup()
    const session = requireOk(await fixture.service.start({ profileId: 'acct-1' }))

    const started = requireOk(fixture.accountEvents.listByType('account.login_started'))
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      profileId: 'acct-1',
      payload: { agentId: 'codex', sessionId: session.sessionId },
    })
    expect(started[0]?.runId).toBeUndefined()

    fixture.events.emit('process.exited', { processId: fixture.processIds[0] ?? '', exitCode: 0 })
    await flushMicrotasks()

    const verified = requireOk(fixture.accountEvents.listByType('account.login_verified'))
    expect(verified).toHaveLength(1)
    expect(verified[0]).toMatchObject({
      profileId: 'acct-1',
      payload: { agentId: 'codex', status: 'ready' },
    })
    const changes = requireOk(fixture.accountEvents.listByType('account.status_changed'))
    expect(changes).toHaveLength(1)
    expect(changes[0]?.payload).toMatchObject({
      status: 'ready',
      previousStatus: 'login-required',
    })
  })

  it('a natural exit that does NOT verify writes no account.login_verified', async () => {
    const fixture = loginSetup({ detectedStatus: 'login-required' })
    await fixture.service.start({ profileId: 'acct-1' })

    fixture.events.emit('process.exited', { processId: fixture.processIds[0] ?? '', exitCode: 1 })
    await flushMicrotasks()

    expect(requireOk(fixture.accountEvents.listByType('account.login_verified'))).toEqual([])
  })

  it('a cancelled session writes neither login_verified nor status_changed', async () => {
    const fixture = loginSetup()
    const session = requireOk(await fixture.service.start({ profileId: 'acct-1' }))
    requireOk(await fixture.service.cancel(session.sessionId))
    await flushMicrotasks()

    expect(requireOk(fixture.accountEvents.listByType('account.login_verified'))).toEqual([])
    expect(requireOk(fixture.accountEvents.listByType('account.status_changed'))).toEqual([])
  })
})
