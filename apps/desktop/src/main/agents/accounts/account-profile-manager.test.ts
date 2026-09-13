import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  createAccountProfileRepository,
  createAgentRunRepository,
  type AccountProfileRepository,
} from '../../db/repositories'
import { createEventBus, type EventBus } from '../../events/event-bus'
import { createTeskraPaths, type TeskraPaths } from '../../paths'
import type { CommandRequest, CommandResult } from '../../process/command-runner'
import { createWorkspaceRuntime, type WorkspaceRuntime } from '../../workspace/runtime'
import { createDefaultAgentRegistry } from '../agent-registry'
import { createAccountProfileManager, type AccountProfileManager } from './account-profile-manager'

/**
 * The fs-touching tests run every profile on a host-NATIVE runtime (wsl ref +
 * hostPlatform 'linux' → NativePosixRuntime), the same parameterization the
 * workspace/git tests use, so they behave identically on Windows and Linux
 * dev hosts. WSL-on-Windows behavior is covered separately with a fake
 * WorkspaceRuntime + fake CommandRunner (see the last describe block).
 */

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const UBUNTU: WorkspaceRuntimeRef = { kind: 'wsl', distro: 'Ubuntu-22.04' }

interface Fixture {
  readonly manager: AccountProfileManager
  readonly profiles: AccountProfileRepository
  readonly events: EventBus<WorkbenchEvents>
  readonly paths: TeskraPaths
  readonly dataRoot: string
  readonly connection: Database.Database
}

function setup(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-accounts-'))
  directories.push(directory)
  const dataRoot = join(directory, 'data')
  const paths = createTeskraPaths({ TESKRA_HOME: dataRoot })

  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  databases.push(connection)
  connection
    .prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-1', 'WS', 'wsl', '/home/u/ws', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
    )
    .run()

  const profiles = createAccountProfileRepository(connection)
  const runs = createAgentRunRepository(connection)
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
    createRuntime,
  })
  return { manager, profiles, events, paths, dataRoot, connection }
}

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

async function requireProfile(fixture: Fixture, id: string): Promise<AgentAccountProfile> {
  const profile = requireOk(await fixture.manager.get(id))
  if (profile === null) throw new Error('expected profile to exist')
  return profile
}

function profileHome(fixture: Fixture, agentId: string, slug: string): string {
  return requireOk(fixture.paths.resolveAgentProfileHome(agentId, slug))
}

async function createManaged(
  fixture: Fixture,
  overrides: Partial<Parameters<AccountProfileManager['create']>[0]> = {},
): Promise<IpcResult<AgentAccountProfile>> {
  return fixture.manager.create({
    agentId: 'codex',
    name: 'Codex Work',
    authType: 'subscription',
    runtime: UBUNTU,
    slug: 'work',
    ...overrides,
  })
}

function seedRun(fixture: Fixture, id: string, profileId: string, status: string): void {
  fixture.connection
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, account_profile_id, created_at, updated_at)
       VALUES (?, 'ws-1', 'codex', ?, 'attended', ?, ?, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
    )
    .run(id, status, `runs/${id}`, profileId)
}

describe('AccountProfileManager create (TASK-097)', () => {
  it('creates a managed profile: generated configHome, directory on disk, defaults', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))

    const home = profileHome(fixture, 'codex', 'work')
    expect(created.configHome).toBe(home)
    expect(existsSync(home)).toBe(true)
    // §46: managed profiles are created with maxConcurrentRuns = 1.
    expect(created.maxConcurrentRuns).toBe(1)
    // A fresh, empty home provably needs a login (§16 state machine).
    expect(created.status).toBe('login-required')
    expect(created.enabled).toBe(true)
    expect(created.runtime).toEqual({ kind: 'wsl', distro: 'ubuntu-22.04' })

    const listed = requireOk(await fixture.manager.list({ agentId: 'codex' }))
    expect(listed.map((profile) => profile.id)).toEqual([created.id])
    expect((await requireProfile(fixture, created.id)).id).toBe(created.id)
  })

  it('emits account.created', async () => {
    const fixture = setup()
    const emitted: string[] = []
    fixture.events.subscribe('account.created', (payload) => emitted.push(payload.profileId))
    const created = requireOk(await createManaged(fixture))
    expect(emitted).toEqual([created.id])
  })

  it('rejects authType api-key with a distinguishable error (§35)', async () => {
    const fixture = setup()
    const result = await createManaged(fixture, { authType: 'api-key' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
  })

  it('rejects an unregistered agentId', async () => {
    const fixture = setup()
    const result = await createManaged(fixture, { agentId: 'not-an-agent' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('lowercases the slug before storing (§48.1 NTFS case folding)', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture, { slug: 'Work' }))
    expect(created.configHome).toBe(profileHome(fixture, 'codex', 'work'))
  })

  it.each(['', '-work', 'work space', 'work_home', 'a'.repeat(33)])(
    'rejects the invalid slug %j',
    async (slug) => {
      const fixture = setup()
      const result = await createManaged(fixture, { slug })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('VALIDATION_FAILED')
    },
  )

  it('reports a duplicate slug and never auto-suffixes it', async () => {
    const fixture = setup()
    requireOk(await createManaged(fixture))
    const duplicate = await createManaged(fixture, { name: 'Second' })
    expect(duplicate.ok).toBe(false)
    if (duplicate.ok) return
    expect(duplicate.error.code).toBe('CONFLICT')
    expect(duplicate.error.message).toContain('Choose a different name')
    // Still exactly one profile and one directory.
    expect(requireOk(await fixture.manager.list()).length).toBe(1)
  })

  it('blocks concurrent same-slug creation via the unique index, leaving no orphans', async () => {
    const fixture = setup()
    const [first, second] = await Promise.all([
      createManaged(fixture, { name: 'A' }),
      createManaged(fixture, { name: 'B' }),
    ])
    const outcomes = [first, second].map((result) => (result.ok ? 'ok' : result.error.code))
    expect(outcomes.sort()).toEqual(['CONFLICT', 'ok'])
    expect(requireOk(await fixture.manager.list()).length).toBe(1)
    // The loser never created anything: the agent directory holds one home.
    const agentDir = join(fixture.paths.agentProfilesRoot(), 'codex')
    expect(requireOk(await fixture.manager.list())[0]?.configHome).toBe(join(agentDir, 'work'))
  })

  it('compensates the INSERT when the home directory cannot be created', async () => {
    const fixture = setup()
    // Root + a FILE where the agent directory would go: mkdir -p fails ENOTDIR.
    const root = fixture.paths.agentProfilesRoot()
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'claude'), 'not a directory')

    const result = await createManaged(fixture, { agentId: 'claude', slug: 'broken' })
    expect(result.ok).toBe(false)
    // The just-inserted row was deleted — no zombie profile pointing at a
    // nonexistent directory (§48.1 compensation).
    expect(requireOk(await fixture.manager.list()).length).toBe(0)
  })

  it('creates an external profile from a user-supplied absolute configHome (§49)', async () => {
    const fixture = setup()
    const configHome = '/home/weston/.codex'
    const created = requireOk(
      await fixture.manager.create({
        agentId: 'codex',
        name: 'Default Codex',
        authType: 'external',
        runtime: UBUNTU,
        configHome,
      }),
    )
    expect(created.configHome).toBe(configHome)
    expect(created.status).toBe('unknown')
    // §46: only managed profiles get the default of 1.
    expect(created.maxConcurrentRuns).toBeUndefined()
    // No directory is created for external homes (managed externally).
    expect(existsSync(fixture.paths.agentProfilesRoot())).toBe(false)
  })

  it('rejects an external profile without configHome or with a non-absolute one', async () => {
    const fixture = setup()
    const missing = await fixture.manager.create({
      agentId: 'codex',
      name: 'X',
      authType: 'external',
      runtime: UBUNTU,
    })
    expect(missing.ok).toBe(false)

    const relative = await fixture.manager.create({
      agentId: 'codex',
      name: 'X',
      authType: 'external',
      runtime: UBUNTU,
      configHome: 'relative/path',
    })
    expect(relative.ok).toBe(false)
    if (relative.ok) return
    expect(relative.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects maxConcurrentRuns below 1 (§46)', async () => {
    const fixture = setup()
    const result = await createManaged(fixture, { maxConcurrentRuns: 0 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('AccountProfileManager update (TASK-097)', () => {
  it('updates name / description / maxConcurrentRuns and emits account.updated', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))
    const emitted: string[] = []
    fixture.events.subscribe('account.updated', (payload) => emitted.push(payload.profileId))

    const updated = requireOk(
      await fixture.manager.update(created.id, {
        name: 'Renamed',
        description: 'd',
        maxConcurrentRuns: 3,
      }),
    )
    expect(updated).toMatchObject({ name: 'Renamed', description: 'd', maxConcurrentRuns: 3 })
    expect(emitted).toEqual([created.id])
  })

  it('rejects configHome updates even when the field is smuggled in (§48.1)', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))
    const result = await fixture.manager.update(created.id, {
      configHome: '/tmp/elsewhere',
    } as unknown as Parameters<AccountProfileManager['update']>[1])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
    expect((await requireProfile(fixture, created.id)).configHome).toBe(created.configHome)
  })

  it('changes status via setStatus and emits account.status_changed', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))
    const statusEvents: string[] = []
    fixture.events.subscribe('account.status_changed', (payload) =>
      statusEvents.push(`${payload.previousStatus}->${payload.status}`),
    )
    const updated = requireOk(await fixture.manager.update(created.id, { status: 'ready' }))
    expect(updated.status).toBe('ready')
    expect(statusEvents).toEqual(['login-required->ready'])
  })

  it('rejects maxConcurrentRuns = 0 on update', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))
    const result = await fixture.manager.update(created.id, { maxConcurrentRuns: 0 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('AccountProfileManager remove / enable (TASK-097, §47)', () => {
  it('remove is a soft disable — the row stays, no DELETE (§47.1)', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))
    const removed = requireOk(await fixture.manager.remove(created.id))
    expect(removed.enabled).toBe(false)
    const persisted = await requireProfile(fixture, created.id)
    expect(persisted.enabled).toBe(false)
    // The home directory is kept unless explicitly requested.
    expect(existsSync(created.configHome as string)).toBe(true)
  })

  it('refuses to disable while a non-terminal run references the profile (§47.2 (4))', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))
    seedRun(fixture, 'run-active', created.id, 'running')

    const result = await fixture.manager.remove(created.id)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CONFLICT')
    expect((await requireProfile(fixture, created.id)).enabled).toBe(true)

    // Once the run is terminal, disabling succeeds.
    fixture.connection
      .prepare(`UPDATE agent_runs SET status = 'completed' WHERE id = 'run-active'`)
      .run()
    const removed = requireOk(await fixture.manager.remove(created.id))
    expect(removed.enabled).toBe(false)
  })

  it('clearing the default when the default profile is disabled (§47.2 (1))', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))
    requireOk(await fixture.manager.setDefault('codex', created.id))
    expect(requireOk(await fixture.manager.getDefault('codex'))).toBe(created.id)

    requireOk(await fixture.manager.remove(created.id))
    expect(requireOk(await fixture.manager.getDefault('codex'))).toBeUndefined()
  })

  it('enable rebuilds a missing home and sets login-required, not unknown (§47.2 (3))', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))
    requireOk(await fixture.manager.update(created.id, { status: 'ready' }))
    requireOk(await fixture.manager.remove(created.id))
    // Simulate the user deleting the home while disabled.
    rmSync(created.configHome as string, { recursive: true, force: true })

    const statusEvents: string[] = []
    fixture.events.subscribe('account.status_changed', (payload) =>
      statusEvents.push(`${payload.previousStatus}->${payload.status}`),
    )
    const enabled = requireOk(await fixture.manager.enable(created.id))
    expect(enabled.enabled).toBe(true)
    expect(enabled.status).toBe('login-required')
    expect(existsSync(created.configHome as string)).toBe(true)
    expect(statusEvents).toEqual(['ready->login-required'])
  })

  it('enable keeps the status when the home still exists', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))
    requireOk(await fixture.manager.update(created.id, { status: 'ready' }))
    requireOk(await fixture.manager.remove(created.id))

    const enabled = requireOk(await fixture.manager.enable(created.id))
    expect(enabled.status).toBe('ready')
  })

  it('deleteHome removes a managed home inside the trusted root', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))
    requireOk(await fixture.manager.remove(created.id, { deleteHome: true }))
    expect(existsSync(created.configHome as string)).toBe(false)
    expect((await requireProfile(fixture, created.id)).enabled).toBe(false)
  })

  it('deleteHome is unavailable for external profiles (§48.2)', async () => {
    const fixture = setup()
    const created = requireOk(
      await fixture.manager.create({
        agentId: 'codex',
        name: 'Default Codex',
        authType: 'external',
        runtime: UBUNTU,
        configHome: '/home/weston/.codex',
      }),
    )
    const result = await fixture.manager.remove(created.id, { deleteHome: true })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('AccountProfileManager ownership guard (TASK-097, §48.2)', () => {
  it('refuses all profile writes when the agent-profiles root is a symlink', async () => {
    const fixture = setup()
    const realDir = join(fixture.dataRoot, 'elsewhere')
    mkdirSync(realDir, { recursive: true })
    symlinkSync(
      realDir,
      fixture.paths.agentProfilesRoot(),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const result = await createManaged(fixture)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(requireOk(await fixture.manager.list()).length).toBe(0)
  })
})

describe('AccountProfileManager defaults (TASK-097, §15)', () => {
  it('round-trips setDefault / getDefault through the global config layer', async () => {
    const fixture = setup()
    const work = requireOk(await createManaged(fixture))
    const personal = requireOk(await createManaged(fixture, { name: 'Personal', slug: 'personal' }))

    expect(requireOk(await fixture.manager.getDefault('codex'))).toBeUndefined()
    requireOk(await fixture.manager.setDefault('codex', work.id))
    expect(requireOk(await fixture.manager.getDefault('codex'))).toBe(work.id)
    requireOk(await fixture.manager.setDefault('codex', personal.id))
    expect(requireOk(await fixture.manager.getDefault('codex'))).toBe(personal.id)
    requireOk(await fixture.manager.setDefault('codex', null))
    expect(requireOk(await fixture.manager.getDefault('codex'))).toBeUndefined()
  })

  it('rejects a default that is missing, cross-agent, or disabled', async () => {
    const fixture = setup()
    const work = requireOk(await createManaged(fixture))

    expect((await fixture.manager.setDefault('codex', 'missing')).ok).toBe(false)
    expect((await fixture.manager.setDefault('claude', work.id)).ok).toBe(false)

    requireOk(await fixture.manager.remove(work.id))
    const disabled = await fixture.manager.setDefault('codex', work.id)
    expect(disabled.ok).toBe(false)
    if (disabled.ok) return
    expect(disabled.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('AccountProfileManager resolve (TASK-097, §37 selector)', () => {
  it('returns undefined (legacy fallback) when nothing is specified and no default is set', async () => {
    const fixture = setup()
    // §37.1: even with exactly one ready profile, never auto-select it.
    const created = requireOk(await createManaged(fixture))
    requireOk(await fixture.manager.update(created.id, { status: 'ready' }))

    const resolved = requireOk(await fixture.manager.resolve('codex', UBUNTU))
    expect(resolved).toBeUndefined()
  })

  it('returns the runtime-compatible default profile', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))
    requireOk(await fixture.manager.setDefault('codex', created.id))

    const resolved = requireOk(await fixture.manager.resolve('codex', UBUNTU))
    expect(resolved?.id).toBe(created.id)
  })

  it('filters out a default from another distro or kind (§37 step 0)', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))
    requireOk(await fixture.manager.setDefault('codex', created.id))

    expect(
      requireOk(await fixture.manager.resolve('codex', { kind: 'wsl', distro: 'Debian' })),
    ).toBeUndefined()
    expect(requireOk(await fixture.manager.resolve('codex', { kind: 'windows' }))).toBeUndefined()
    // Distro comparison is case-insensitive (stored lowercase).
    expect(requireOk(await fixture.manager.resolve('codex', UBUNTU))?.id).toBe(created.id)
  })

  it('prefers the explicit profile over the default', async () => {
    const fixture = setup()
    const work = requireOk(await createManaged(fixture))
    const personal = requireOk(await createManaged(fixture, { name: 'Personal', slug: 'personal' }))
    requireOk(await fixture.manager.setDefault('codex', work.id))

    const resolved = requireOk(await fixture.manager.resolve('codex', UBUNTU, personal.id))
    expect(resolved?.id).toBe(personal.id)
  })

  it('errors on an explicit but runtime-incompatible profile — never silently downgrades', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))
    const result = await fixture.manager.resolve('codex', { kind: 'windows' }, created.id)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('ACCOUNT_PROFILE_INCOMPATIBLE')
  })

  it('errors on an explicit disabled profile', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))
    requireOk(await fixture.manager.remove(created.id))
    const result = await fixture.manager.resolve('codex', UBUNTU, created.id)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('ACCOUNT_PROFILE_DISABLED')
  })

  it('errors on a disabled default and does NOT fall back to legacy (§47.2 (2))', async () => {
    const fixture = setup()
    const created = requireOk(await createManaged(fixture))
    requireOk(await fixture.manager.setDefault('codex', created.id))
    // Simulate an external modification: the row is disabled while the
    // default still points at it (manager.remove would have cleared it).
    const disabled = fixture.profiles.disable(created.id)
    expect(disabled.ok).toBe(true)

    const result = await fixture.manager.resolve('codex', UBUNTU)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('ACCOUNT_PROFILE_DISABLED')
    expect(result.error.message).toContain('default')
  })
})

// ---------------------------------------------------------------------------
// WSL-on-Windows: fake WorkspaceRuntime (hostNative=false) + fake CommandRunner
// executing an in-memory distro filesystem. Asserts argv-array execution
// (never a shell string) and the same ownership-guard semantics.
// ---------------------------------------------------------------------------

class FakeDistroFs {
  readonly dirs = new Set<string>(['/home/u'])
  readonly symlinks = new Map<string, string>()
  readonly calls: { command: string; args: readonly string[] }[] = []

  private canonicalize(path: string): string {
    const segments = path.split('/').filter((segment) => segment.length > 0)
    const resolved: string[] = []
    for (const segment of segments) {
      resolved.push(segment)
      const current = `/${resolved.join('/')}`
      const target = this.symlinks.get(current)
      if (target !== undefined) {
        resolved.length = 0
        resolved.push(...target.split('/').filter((part) => part.length > 0))
      }
    }
    return `/${resolved.join('/')}`
  }

  private exists(path: string): boolean {
    const canonical = this.canonicalize(path)
    return this.dirs.has(canonical)
  }

  run(request: CommandRequest): Promise<IpcResult<CommandResult>> {
    const [flag, ...rest] = request.args ?? []
    const path = rest.at(-1) ?? ''
    this.calls.push({ command: request.command, args: request.args ?? [] })
    const reply = (exitCode: number, stdout = ''): Promise<IpcResult<CommandResult>> =>
      Promise.resolve({ ok: true, data: { stdout, stderr: '', exitCode } })

    switch (request.command) {
      case 'test': {
        if (flag === '-e') return this.exists(path) || this.symlinks.has(path) ? reply(0) : reply(1)
        if (flag === '-d') return this.exists(path) ? reply(0) : reply(1)
        if (flag === '-L') return this.symlinks.has(path) ? reply(0) : reply(1)
        return reply(1)
      }
      case 'mkdir': {
        const canonical = this.canonicalize(path)
        const segments = canonical.split('/').filter((segment) => segment.length > 0)
        for (let index = 1; index <= segments.length; index += 1) {
          this.dirs.add(`/${segments.slice(0, index).join('/')}`)
        }
        return reply(0)
      }
      case 'realpath':
        return reply(0, `${this.canonicalize(path)}\n`)
      case 'rm': {
        const canonical = this.canonicalize(path)
        for (const dir of [...this.dirs]) {
          if (dir === canonical || dir.startsWith(`${canonical}/`)) this.dirs.delete(dir)
        }
        return reply(0)
      }
      default:
        return reply(127)
    }
  }
}

function fakeWslRuntime(): WorkspaceRuntime {
  return {
    ref: { kind: 'wsl', distro: 'Ubuntu-22.04' },
    hostNative: false,
    resolveCommand: (command, args = [], cwd) => ({
      executable: command,
      args,
      ...(cwd !== undefined ? { cwd } : {}),
    }),
    resolveTerminal: () => ({ ok: true, data: { command: 'bash', args: ['-l'] } }),
    resolveCwd: (path) => path,
    resolveHostPath: (path) => ({ ok: true, data: path }),
    resolveDataRoot: () => '/home/u/.teskra',
    resolveAgentProfilesRoot: () => '/home/u/.teskra/agent-profiles',
    resolveAgentProfileHome: (agentId, slug) => ({
      ok: true,
      data: `/home/u/.teskra/agent-profiles/${agentId}/${slug}`,
    }),
    validate: () => ({ ok: true, data: { kind: 'wsl', hostNative: false } }),
  }
}

function setupWslOnWindows(fs: FakeDistroFs): Fixture {
  const fixture = setup()
  const registry = createDefaultAgentRegistry(false)
  if (!registry.ok) throw new Error('expected Agent Registry')
  const config = createConfigService({ paths: fixture.paths })
  const manager = createAccountProfileManager({
    profiles: fixture.profiles,
    runs: createAgentRunRepository(fixture.connection),
    registry: registry.data,
    paths: fixture.paths,
    config,
    events: fixture.events,
    createRuntime: () => ({ ok: true, data: fakeWslRuntime() }),
    commands: { run: (request) => fs.run(request) },
  })
  return { ...fixture, manager }
}

describe('AccountProfileManager on WSL-on-Windows (TASK-097, §48.2 (b))', () => {
  it('creates the root and home with argv commands inside the distro', async () => {
    const fs = new FakeDistroFs()
    const fixture = setupWslOnWindows(fs)

    const created = requireOk(await createManaged(fixture))
    expect(created.configHome).toBe('/home/u/.teskra/agent-profiles/codex/work')
    expect(fs.dirs.has('/home/u/.teskra/agent-profiles/codex/work')).toBe(true)

    // Every fs operation went through CommandRunner as argv — no shell strings.
    const mkdir = fs.calls.filter((call) => call.command === 'mkdir')
    expect(mkdir.length).toBeGreaterThan(0)
    for (const call of fs.calls) {
      expect(call.command).not.toBe('bash')
      expect(call.command).not.toBe('sh')
    }
    expect(mkdir.some((call) => call.args.includes('-p'))).toBe(true)
  })

  it('rejects profile creation when the distro root is a symlink', async () => {
    const fs = new FakeDistroFs()
    fs.dirs.add('/elsewhere')
    fs.symlinks.set('/home/u/.teskra/agent-profiles', '/elsewhere')
    const fixture = setupWslOnWindows(fs)

    const result = await createManaged(fixture)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(requireOk(await fixture.manager.list()).length).toBe(0)
  })

  it('rejects a home whose path escapes the trusted root via a mid-chain symlink', async () => {
    const fs = new FakeDistroFs()
    const fixture = setupWslOnWindows(fs)

    // Establish the trusted root first, then swap a mid-chain directory for a
    // symlink in the check-to-create window.
    requireOk(await createManaged(fixture, { slug: 'first' }))
    fs.symlinks.set('/home/u/.teskra/agent-profiles/codex', '/etc')
    fs.dirs.add('/etc')

    const result = await createManaged(fixture, { slug: 'second' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
    // Compensation removed the INSERTed row.
    expect(requireOk(await fixture.manager.list()).length).toBe(1)
  })

  it('enable rebuilds a missing home inside the distro and sets login-required', async () => {
    const fs = new FakeDistroFs()
    const fixture = setupWslOnWindows(fs)
    const created = requireOk(await createManaged(fixture))
    requireOk(await fixture.manager.remove(created.id))
    await fs.run({
      command: 'rm',
      args: ['-rf', '--', created.configHome as string],
      timeoutMs: 1000,
    })
    expect(fs.dirs.has(created.configHome as string)).toBe(false)

    const enabled = requireOk(await fixture.manager.enable(created.id))
    expect(enabled.status).toBe('login-required')
    expect(fs.dirs.has(created.configHome as string)).toBe(true)
  })

  it('deleteHome removes a managed home inside the distro', async () => {
    const fs = new FakeDistroFs()
    const fixture = setupWslOnWindows(fs)
    const created = requireOk(await createManaged(fixture))
    requireOk(await fixture.manager.remove(created.id, { deleteHome: true }))
    expect(fs.dirs.has(created.configHome as string)).toBe(false)
    const rm = fs.calls.find((call) => call.command === 'rm')
    expect(rm?.args).toEqual(['-rf', '--', created.configHome])
  })
})
