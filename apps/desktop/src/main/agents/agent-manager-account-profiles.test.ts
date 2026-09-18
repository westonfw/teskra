import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentAccountProfile,
  AgentDetectionResult,
  AgentRun,
  IpcResult,
  WorkbenchEvents,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'

import { createConfigService } from '../config/config-service'
import { runMigrations } from '../db/migrate'
import { MIGRATIONS, migrateDatabase } from '../db/migrations'
import {
  createAccountProfileRepository,
  createAgentEventRepository,
  createAgentRunRepository,
  createHandoffRepository,
  createTaskRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
  type AccountProfileRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createTeskraPaths, type TeskraPaths } from '../paths'
import type { ProcessStartRequest } from '../process/process-manager'
import type { WorkspaceRuntime } from '../workspace/runtime'
import type { CodingAgentAdapter } from './adapters/coding-agent-adapter'
import { createCodexAdapter } from './adapters/codex-adapter'
import { createAgentManager, type AgentManager } from './agent-manager'
import { createBuiltInAgentRegistry } from './agent-registry'
import { createRunLogStore } from './run-log-store'
import {
  createAccountProfileAdapterRegistry,
  type AccountProfileAdapterRegistry,
} from './accounts/account-profile-adapter'
import {
  createAccountProfileManager,
  type AccountProfileManager,
} from './accounts/account-profile-manager'
import { createClaudeAccountProfileAdapter } from './accounts/adapters/claude-account-profile-adapter'
import { createCodexAccountProfileAdapter } from './accounts/adapters/codex-account-profile-adapter'
import { assertNoReservedEnvKeys } from './accounts/reserved-env-keys'
import { projectHistoricalProfileIdentity } from './accounts/runtime-identity'

/**
 * TASK-100 — AgentManager Profile Integration (Milestone 24 §7/§13/§14).
 *
 * Uses the REAL Codex CLI adapter with a fake ProcessManager, so assertions
 * see the exact env the ProcessManager would receive (§13.1 slot order), and
 * the real AccountProfileManager + repositories, so the run-row snapshot is
 * read back through the same code production uses.
 */

const UBUNTU: WorkspaceRuntimeRef = { kind: 'wsl', distro: 'ubuntu-22.04' }
const WORK_HOME = '/home/u/.teskra/agent-profiles/codex/work'
const PERSONAL_HOME = '/home/u/.teskra/agent-profiles/codex/personal'
const CLAUDE_HOME = '/home/u/.teskra/agent-profiles/claude/work'

const databases: Database.Database[] = []
const directories: string[] = []
const managers: AgentManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose()
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

/** Minimal runtime object — the Codex/Claude profile projection never reads it. */
const FAKE_RUNTIME = { ref: UBUNTU } as unknown as WorkspaceRuntime

function detection(agentId: string): AgentDetectionResult {
  return {
    agentId,
    runtime: UBUNTU,
    installed: true,
    executable: agentId,
    version: 'test',
    overridden: false,
    fromCache: false,
    checkedAt: '2026-09-12T00:00:00.000Z',
  }
}

interface CapturedProcesses {
  readonly adapter: Pick<
    import('../process/process-manager').ProcessManager,
    'start' | 'write' | 'resize' | 'stop'
  >
  readonly starts: ProcessStartRequest[]
}

function fakeProcesses(): CapturedProcesses {
  const starts: ProcessStartRequest[] = []
  return {
    starts,
    adapter: {
      start: (request: ProcessStartRequest) => {
        starts.push(request)
        return {
          ok: true as const,
          data: {
            id: request.id,
            pid: 4242,
            startedAt: '2026-09-12T00:00:01.000Z',
            runtime: request.runtime,
          } as import('../process/process-manager').ManagedProcess,
        }
      },
      write: () => ({ ok: true as const, data: undefined }),
      resize: () => ({ ok: true as const, data: undefined }),
      stop: () =>
        Promise.resolve({
          ok: true as const,
          data: { exit: { processId: 'agent-run:x', exitCode: 0 }, stage: 'terminate' as const },
        }),
    },
  }
}

interface Fixture {
  readonly connection: Database.Database
  readonly events: EventBus<WorkbenchEvents>
  readonly manager: AgentManager
  readonly accountProfiles: AccountProfileManager
  readonly profileAdapters: AccountProfileAdapterRegistry
  readonly profiles: AccountProfileRepository
  readonly runs: ReturnType<typeof createAgentRunRepository>
  readonly agentEvents: ReturnType<typeof createAgentEventRepository>
  readonly workspaces: ReturnType<typeof createWorkspaceRepository>
  readonly processes: CapturedProcesses
  readonly codex: CodingAgentAdapter
  readonly paths: TeskraPaths
}

function setup(options: { withAccountProfiles?: boolean; legacyUpgrade?: boolean } = {}): Fixture {
  const withAccountProfiles = options.withAccountProfiles !== false
  const directory = mkdtempSync(join(tmpdir(), 'teskra-task100-'))
  directories.push(directory)
  const paths = createTeskraPaths({ TESKRA_HOME: join(directory, 'data') })

  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  if (options.legacyUpgrade === true) {
    // TASK-113 (§51): simulate a pre-Milestone-24 database — apply up to v11,
    // hold real pre-upgrade rows, then let the normal migration chain finish.
    const upToEleven = runMigrations(connection, MIGRATIONS.slice(0, 11))
    if (!upToEleven.ok) throw new Error(upToEleven.error.message)
    connection
      .prepare(
        `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
         VALUES ('legacy-ws', 'Legacy WS', 'wsl', '/legacy', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')`,
      )
      .run()
    connection
      .prepare(
        `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
         VALUES ('legacy-run', 'legacy-ws', 'codex', 'failed', 'attended', 'runs/legacy-run', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')`,
      )
      .run()
  }
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  databases.push(connection)

  const workspaces = createWorkspaceRepository(connection)
  const tasks = createTaskRepository(connection)
  const runs = createAgentRunRepository(connection)
  const agentEvents = createAgentEventRepository(connection)
  const handoffs = createHandoffRepository(connection)
  const worktrees = createWorktreeRepository(connection)
  const profiles = createAccountProfileRepository(connection)
  requireOk(
    workspaces.create(
      {
        id: 'workspace-1',
        name: 'Demo',
        runtime: UBUNTU,
        path: '/repo',
      },
      '2026-09-12T00:00:00.000Z',
    ),
  )

  const registry = createBuiltInAgentRegistry()
  if (!registry.ok) throw new Error('expected Agent Registry')
  const events = createEventBus<WorkbenchEvents>()
  const config = createConfigService({ paths, workspaces })
  const resolveRuntime = (): IpcResult<WorkspaceRuntime> => ({ ok: true, data: FAKE_RUNTIME })

  const profileAdapters = requireOk(
    createAccountProfileAdapterRegistry([
      createCodexAccountProfileAdapter({ createRuntime: resolveRuntime }),
      createClaudeAccountProfileAdapter({ createRuntime: resolveRuntime }),
    ]),
  )
  const accountProfiles = createAccountProfileManager({
    profiles,
    runs,
    registry: registry.data,
    paths,
    config,
    events,
    adapters: profileAdapters,
    createRuntime: resolveRuntime,
  })

  const processes = fakeProcesses()
  const detector = {
    detect: vi.fn(async ({ agentId }: { agentId: string }) => ({
      ok: true as const,
      data: detection(agentId),
    })),
    getExecutableOverride: vi.fn(() => ({ ok: true as const, data: null })),
  }
  const codex = createCodexAdapter({ processes: processes.adapter, detector, resolveRuntime })
  let nextRun = 1
  const manager = createAgentManager({
    registry: registry.data,
    adapters: [codex],
    runs,
    agentEvents,
    handoffs,
    workspaces,
    tasks,
    worktrees,
    events,
    paths,
    runLogs: createRunLogStore({ paths }),
    createRunId: () => `run-${String(nextRun++)}`,
    now: () => '2026-09-12T00:00:02.000Z',
    ...(withAccountProfiles ? { accountProfiles, resolveRuntime } : {}),
  })
  managers.push(manager)
  return {
    connection,
    events,
    manager,
    accountProfiles,
    profileAdapters,
    profiles,
    runs,
    agentEvents,
    workspaces,
    processes,
    codex,
    paths,
  }
}

async function createExternalProfile(
  fixture: Fixture,
  overrides: Partial<Parameters<AccountProfileManager['create']>[0]> = {},
): Promise<AgentAccountProfile> {
  return requireOk(
    await fixture.accountProfiles.create({
      agentId: 'codex',
      name: 'Codex Work',
      authType: 'external',
      runtime: UBUNTU,
      configHome: WORK_HOME,
      ...overrides,
    }),
  )
}

function envOf(fixture: Fixture, index = 0): Readonly<Record<string, string>> {
  const env = fixture.processes.starts[index]?.env
  if (env === undefined) throw new Error('expected a launched process')
  return env
}

describe('assertNoReservedEnvKeys (§13.2)', () => {
  it('passes env without reserved keys and rejects offenders with their source', () => {
    expect(assertNoReservedEnvKeys(undefined, 'workspace.env', ['CODEX_HOME'])).toEqual({
      ok: true,
      data: undefined,
    })
    expect(assertNoReservedEnvKeys({ PATH: '/bin' }, 'workspace.env', ['CODEX_HOME'])).toEqual({
      ok: true,
      data: undefined,
    })
    const rejected = assertNoReservedEnvKeys(
      { CODEX_HOME: '/elsewhere', PATH: '/bin' },
      'request.environment',
      ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'],
    )
    expect(rejected.ok).toBe(false)
    if (rejected.ok) return
    expect(rejected.error.code).toBe('VALIDATION_FAILED')
    expect(rejected.error.message).toContain('request.environment')
    expect(rejected.error.message).toContain('CODEX_HOME')
  })
})

describe('AgentManager account profile integration (TASK-100)', () => {
  it('upgraded-from-v11 database: zero profile rows, legacy start stays byte-identical (TASK-113, §50.1/§51)', async () => {
    const fixture = setup({ legacyUpgrade: true })
    // §51: the upgrade creates tables only — no virtual default Profile (§50).
    for (const table of ['agent_account_profiles', 'account_events', 'profile_aliases']) {
      expect(fixture.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({
        n: 0,
      })
    }
    // Historical runs gained the identity columns as NULL.
    expect(
      fixture.connection
        .prepare(
          `SELECT account_profile_id, profile_snapshot_json FROM agent_runs WHERE id = 'legacy-run'`,
        )
        .get(),
    ).toEqual({ account_profile_id: null, profile_snapshot_json: null })

    const started = await fixture.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })

    expect(started).toMatchObject({ ok: true, data: { id: 'run-1', status: 'running' } })
    // §50.1: no CODEX_HOME / CLAUDE_CONFIG_DIR projection — the CLI keeps
    // using its own default home, exactly as before the upgrade.
    const env = envOf(fixture)
    expect(env).not.toHaveProperty('CODEX_HOME')
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    const run = requireOk(fixture.runs.getById('run-1'))
    expect(run?.accountProfileId).toBeUndefined()
    expect(run?.profileSnapshot).toBeUndefined()
  })

  it('legacy start (no profile, no default) projects no config dir env — byte-identical (§52)', async () => {
    const fixture = setup()
    // A profile EXISTING but not being the default must not change anything (§37.1).
    await createExternalProfile(fixture)

    const started = await fixture.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })

    expect(started).toMatchObject({ ok: true, data: { id: 'run-1', status: 'running' } })
    const env = envOf(fixture)
    expect(env).not.toHaveProperty('CODEX_HOME')
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(env.TESKRA_RUN_ID).toBe('run-1')
    const run = requireOk(fixture.runs.getById('run-1'))
    expect(run?.accountProfileId).toBeUndefined()
    expect(run?.profileSnapshot).toBeUndefined()
  })

  it('explicit profile start projects CODEX_HOME into the ProcessManager env and persists the snapshot (§7/§13.1)', async () => {
    const fixture = setup()
    const work = await createExternalProfile(fixture)

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: work.id,
      model: 'gpt-5',
    })

    expect(started).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(envOf(fixture).CODEX_HOME).toBe(WORK_HOME)
    const run = requireOk(fixture.runs.getById('run-1'))
    expect(run?.accountProfileId).toBe(work.id)
    expect(run?.profileSnapshot).toEqual({
      accountProfileId: work.id,
      accountProfileName: 'Codex Work',
      runtime: UBUNTU,
      configHome: WORK_HOME,
      model: 'gpt-5',
    })
  })

  it('default profile start resolves through config and records it in the snapshot (§14/§15)', async () => {
    const fixture = setup()
    const work = await createExternalProfile(fixture)
    requireOk(await fixture.accountProfiles.setDefault('codex', work.id))

    const started = await fixture.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })

    expect(started).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(envOf(fixture).CODEX_HOME).toBe(WORK_HOME)
    const run = requireOk(fixture.runs.getById('run-1'))
    expect(run?.accountProfileId).toBe(work.id)
  })

  it('explicit override wins over the default and the snapshot records the override (§14)', async () => {
    const fixture = setup()
    const work = await createExternalProfile(fixture)
    const personal = await createExternalProfile(fixture, {
      name: 'Codex Personal',
      configHome: PERSONAL_HOME,
    })
    requireOk(await fixture.accountProfiles.setDefault('codex', work.id))

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: personal.id,
    })

    expect(started).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(envOf(fixture).CODEX_HOME).toBe(PERSONAL_HOME)
    const run = requireOk(fixture.runs.getById('run-1'))
    expect(run?.profileSnapshot?.accountProfileId).toBe(personal.id)
    expect(run?.profileSnapshot?.accountProfileName).toBe('Codex Personal')
  })

  it('profile env is written LAST — it overwrites even a smuggled workspace/request CODEX_HOME (§13.1)', async () => {
    // Bypass the §13.2 rejection by calling the adapter directly (the
    // rejection is covered separately) to prove the slot order itself.
    const fixture = setup()
    const workspace = requireOk(fixture.workspaces.getById('workspace-1'))
    if (workspace === null) throw new Error('expected workspace')
    await fixture.codex.start({
      runId: 'run-x',
      workspace: { ...workspace, env: { CODEX_HOME: '/smuggled-workspace' } },
      environment: { CODEX_HOME: '/smuggled-request' },
      profileEnvironment: { CODEX_HOME: WORK_HOME },
      approvalMode: 'read-only',
    })
    const env = envOf(fixture)
    expect(env.CODEX_HOME).toBe(WORK_HOME)
    expect(env.TESKRA_RUN_ID).toBe('run-x')
  })

  it('rejects a reserved key in workspace.env and never launches (§13.2)', async () => {
    const fixture = setup()
    requireOk(fixture.workspaces.update('workspace-1', { env: { CODEX_HOME: '/evil' } }))

    const started = await fixture.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })

    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.error.code).toBe('VALIDATION_FAILED')
    expect(started.error.message).toContain('workspace.env')
    expect(started.error.message).toContain('CODEX_HOME')
    expect(fixture.processes.starts).toHaveLength(0)
    expect(requireOk(fixture.runs.listByWorkspace('workspace-1'))).toHaveLength(0)
  })

  it('rejects a reserved key in request.environment and never launches (§13.2)', async () => {
    const fixture = setup()

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      environment: { CLAUDE_CONFIG_DIR: '/evil' },
    })

    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.error.code).toBe('VALIDATION_FAILED')
    expect(started.error.message).toContain('request.environment')
    expect(started.error.message).toContain('CLAUDE_CONFIG_DIR')
    expect(fixture.processes.starts).toHaveLength(0)
  })

  it('rejects executionProfileId when no ExecutionProfileManager is composed (TASK-110)', async () => {
    const fixture = setup()

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionProfileId: 'exec-1',
    })

    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
    expect(started.error.message).toContain('Execution profiles')
    expect(fixture.processes.starts).toHaveLength(0)
  })

  it('rejects an explicit profile belonging to another agent (ACCOUNT_PROFILE_MISMATCH)', async () => {
    const fixture = setup()
    const claudeProfile = await createExternalProfile(fixture, {
      agentId: 'claude',
      name: 'Claude Work',
      configHome: CLAUDE_HOME,
    })

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: claudeProfile.id,
    })

    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.error.code).toBe('ACCOUNT_PROFILE_MISMATCH')
  })

  it('rejects an explicit profile that does not exist (ACCOUNT_PROFILE_NOT_FOUND)', async () => {
    const fixture = setup()

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: 'acct-gone',
    })

    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.error.code).toBe('ACCOUNT_PROFILE_NOT_FOUND')
  })

  it('rejects an explicit disabled profile — never silently downgrades (ACCOUNT_PROFILE_DISABLED, §37.1)', async () => {
    const fixture = setup()
    const work = await createExternalProfile(fixture)
    requireOk(await fixture.accountProfiles.remove(work.id))

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: work.id,
    })

    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.error.code).toBe('ACCOUNT_PROFILE_DISABLED')
  })

  it('rejects an explicit profile for another runtime (ACCOUNT_PROFILE_INCOMPATIBLE)', async () => {
    const fixture = setup()
    const windowsProfile = await createExternalProfile(fixture, {
      name: 'Codex Windows',
      runtime: { kind: 'windows' },
      configHome: 'C:\\Users\\u\\.codex-work',
    })

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: windowsProfile.id,
    })

    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.error.code).toBe('ACCOUNT_PROFILE_INCOMPATIBLE')
  })

  it('rejects an explicit accountProfileId when no account profile support is composed', async () => {
    const fixture = setup({ withAccountProfiles: false })

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: 'acct-1',
    })

    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
    // …while a legacy start on the same manager works unchanged.
    const legacy = await fixture.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    expect(legacy).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(envOf(fixture)).not.toHaveProperty('CODEX_HOME')
  })

  it('switching the default profile only affects NEW starts — the historical run keeps its snapshot (TASK-101, §65 scenario E)', async () => {
    const fixture = setup()
    const work = await createExternalProfile(fixture)
    const personal = await createExternalProfile(fixture, {
      name: 'Codex Personal',
      configHome: PERSONAL_HOME,
    })
    requireOk(await fixture.accountProfiles.setDefault('codex', work.id))

    const first = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      approvalMode: 'read-only',
    })
    expect(first).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(envOf(fixture, 0).CODEX_HOME).toBe(WORK_HOME)
    expect(requireOk(fixture.runs.getById('run-1'))?.profileSnapshot).toMatchObject({
      accountProfileId: work.id,
      accountProfileName: 'Codex Work',
      configHome: WORK_HOME,
    })

    requireOk(await fixture.accountProfiles.setDefault('codex', personal.id))
    const second = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      approvalMode: 'read-only',
    })

    expect(second).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(envOf(fixture, 1).CODEX_HOME).toBe(PERSONAL_HOME)
    expect(requireOk(fixture.runs.getById('run-2'))?.profileSnapshot?.accountProfileId).toBe(
      personal.id,
    )
    // The default change did not rewrite history.
    expect(requireOk(fixture.runs.getById('run-1'))?.profileSnapshot).toMatchObject({
      accountProfileId: work.id,
      accountProfileName: 'Codex Work',
      configHome: WORK_HOME,
    })
  })
})

describe('AgentManager per-profile concurrency (TASK-117, §46/§65 scenario H)', () => {
  // The fixture uses DEFAULT_CONFIG.concurrency (maxRunsPerAgent = 2), so two
  // codex runs never trip the global per-agent limit — any queueing observed
  // here comes from the per-profile limit alone.
  const exited = (fixture: Fixture, runId: string): void => {
    fixture.events.emit('process.exited', {
      processId: `codex:${runId}`,
      agentRunId: runId,
      exitCode: 0,
    })
  }

  it('queues the second run of the same profile at maxConcurrentRuns = 1 and advances it on release', async () => {
    const fixture = setup()
    const work = await createExternalProfile(fixture, { maxConcurrentRuns: 1 })

    const first = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: work.id,
      approvalMode: 'read-only',
    })
    const second = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: work.id,
      approvalMode: 'read-only',
    })

    expect(first).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(second).toMatchObject({ ok: true, data: { status: 'queued' } })
    expect(fixture.processes.starts).toHaveLength(1)

    // The existing queue path re-evaluates capacity when the slot frees up.
    exited(fixture, 'run-1')
    await vi.waitFor(() => {
      expect(fixture.manager.get('run-2')).toMatchObject({
        ok: true,
        data: { status: 'running' },
      })
    })
    expect(fixture.processes.starts).toHaveLength(2)
    expect(envOf(fixture, 1).CODEX_HOME).toBe(WORK_HOME)
  })

  it('runs two DIFFERENT profiles of the same agent in parallel (§45)', async () => {
    const fixture = setup()
    const work = await createExternalProfile(fixture, { maxConcurrentRuns: 1 })
    const personal = await createExternalProfile(fixture, {
      name: 'Codex Personal',
      configHome: PERSONAL_HOME,
      maxConcurrentRuns: 1,
    })

    const first = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: work.id,
      approvalMode: 'read-only',
    })
    const second = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: personal.id,
      approvalMode: 'read-only',
    })

    expect(first).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(second).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(envOf(fixture, 0).CODEX_HOME).toBe(WORK_HOME)
    expect(envOf(fixture, 1).CODEX_HOME).toBe(PERSONAL_HOME)
  })

  it('leaves legacy runs (no accountProfileId) under maxRunsPerAgent only — no per-profile limit', async () => {
    const fixture = setup()
    // A maxed-out profile must not leak its limit onto profile-less runs.
    await createExternalProfile(fixture, { maxConcurrentRuns: 1 })

    const first = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      approvalMode: 'read-only',
    })
    const second = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      approvalMode: 'read-only',
    })

    expect(first).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(second).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(fixture.processes.starts).toHaveLength(2)
  })

  it('allows two parallel runs on the same profile once maxConcurrentRuns is raised to 2', async () => {
    const fixture = setup()
    const work = await createExternalProfile(fixture, { maxConcurrentRuns: 2 })

    const first = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: work.id,
      approvalMode: 'read-only',
    })
    const second = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: work.id,
      approvalMode: 'read-only',
    })

    expect(first).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(second).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(fixture.processes.starts).toHaveLength(2)
  })
})

describe('AgentManager resume with profile identity (TASK-100, §10.5/§38)', () => {
  const interrupt = (fixture: Fixture, runId: string) => {
    const updated = fixture.runs.update(
      runId,
      {
        status: 'interrupted',
        processId: null,
        pid: null,
        finishedAt: '2026-09-12T00:00:03.000Z',
        exitCode: 1,
        error: { message: 'process lost' },
      },
      '2026-09-12T00:00:03.000Z',
    )
    if (!updated.ok) throw new Error(updated.error.message)
  }

  /** Give an interrupted run a recorded Codex session (as a real launch would). */
  const recordSession = (
    fixture: Fixture,
    runId: string,
    session: Record<string, unknown>,
  ): void => {
    const updated = fixture.runs.update(runId, { providerSession: session })
    if (!updated.ok) throw new Error(updated.error.message)
  }

  it('resumes a profile run with the HISTORICAL identity after the default changed (§38)', async () => {
    const fixture = setup()
    const work = await createExternalProfile(fixture)
    const personal = await createExternalProfile(fixture, {
      name: 'Codex Personal',
      configHome: PERSONAL_HOME,
    })
    await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: work.id,
    })
    recordSession(fixture, 'run-1', { provider: 'codex', sessionId: 'sess-work' })
    interrupt(fixture, 'run-1')
    // The crash-restart window: the user switched the default to Personal.
    requireOk(await fixture.accountProfiles.setDefault('codex', personal.id))

    const resumed = await fixture.manager.resume({ runId: 'run-1' })

    expect(resumed).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(envOf(fixture, 1).CODEX_HOME).toBe(WORK_HOME)
  })

  it('resumes a legacy run WITHOUT projecting the current default profile (§38/§52)', async () => {
    const fixture = setup()
    const work = await createExternalProfile(fixture)
    await fixture.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    interrupt(fixture, 'run-1')
    requireOk(await fixture.accountProfiles.setDefault('codex', work.id))

    const resumed = await fixture.manager.resume({ runId: 'run-1' })

    expect(resumed).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(envOf(fixture, 1)).not.toHaveProperty('CODEX_HOME')
  })

  it('codex native resume passes the resume profile context to the adapter (session id kept, no --last)', async () => {
    const fixture = setup()
    const work = await createExternalProfile(fixture)
    await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: work.id,
    })
    recordSession(fixture, 'run-1', { provider: 'codex', sessionId: 'sess-123' })
    interrupt(fixture, 'run-1')

    const resumed = await fixture.manager.resume({ runId: 'run-1' })

    expect(resumed).toMatchObject({ ok: true, data: { status: 'running' } })
    const resumeRequest = fixture.processes.starts[1]
    expect(resumeRequest?.env?.CODEX_HOME).toBe(WORK_HOME)
    const args = resumeRequest?.args ?? []
    expect(args).toContain('resume')
    expect(args).toContain('sess-123')
    expect(args).not.toContain('--last')
  })

  it('codex native resume without a session id is refused for a profile run (no --last fallback, §10.5 (2))', async () => {
    const fixture = setup()
    const work = await createExternalProfile(fixture)
    await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: work.id,
    })
    recordSession(fixture, 'run-1', { provider: 'codex' })
    interrupt(fixture, 'run-1')

    const resumed = await fixture.manager.resume({ runId: 'run-1' })

    // The launch fails the run loudly instead of guessing a session.
    expect(resumed).toMatchObject({ ok: true, data: { status: 'failed' } })
    if (resumed.ok) {
      expect(resumed.data.error?.code).toBe('VALIDATION_FAILED')
      expect(String(resumed.data.error?.message)).toContain('--last')
    }
    expect(fixture.processes.starts).toHaveLength(1)
  })

  it('codex native resume is refused when the resolved configHome drifted from the snapshot (§10.5 (1))', async () => {
    const fixture = setup()
    const work = await createExternalProfile(fixture)
    await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      accountProfileId: work.id,
    })
    recordSession(fixture, 'run-1', { provider: 'codex', sessionId: 'sess-123' })
    interrupt(fixture, 'run-1')
    // Simulate external tampering: the profile row now names another home.
    fixture.connection
      .prepare('UPDATE agent_account_profiles SET config_home = ? WHERE id = ?')
      .run('/home/u/.codex-tampered', work.id)

    const resumed = await fixture.manager.resume({ runId: 'run-1' })

    expect(resumed).toMatchObject({ ok: true, data: { status: 'failed' } })
    if (resumed.ok) {
      expect(resumed.data.error?.code).toBe('CONFLICT')
      expect(String(resumed.data.error?.message)).toContain('different account profile')
    }
    expect(fixture.processes.starts).toHaveLength(1)
  })

  it('legacy codex resume keeps the --last fallback (unchanged behavior)', async () => {
    const fixture = setup()
    await fixture.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    recordSession(fixture, 'run-1', { provider: 'codex' })
    interrupt(fixture, 'run-1')

    const resumed = await fixture.manager.resume({ runId: 'run-1' })

    expect(resumed).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(fixture.processes.starts[1]?.args).toContain('--last')
  })
})

describe('projectHistoricalProfileIdentity (§38)', () => {
  const snapshotRun = (overrides: Partial<AgentRun> = {}): AgentRun =>
    ({
      id: 'run-1',
      agentType: 'codex',
      accountProfileId: 'acct-1',
      profileSnapshot: {
        accountProfileId: 'acct-1',
        accountProfileName: 'Codex Work',
        runtime: UBUNTU,
        configHome: WORK_HOME,
      },
      ...overrides,
    }) as AgentRun

  const adapter = createCodexAccountProfileAdapter()

  it('projects the snapshot configHome when the profile row is deleted (snapshot is the truth)', () => {
    const projected = projectHistoricalProfileIdentity({
      run: snapshotRun(),
      profile: null,
      adapter,
      runtime: FAKE_RUNTIME,
      workspaceRuntime: UBUNTU,
    })
    expect(projected.ok).toBe(true)
    if (!projected.ok) return
    expect(projected.data.env).toEqual({ CODEX_HOME: WORK_HOME })
    expect(projected.data.resumeProfileContext).toEqual({
      accountProfileId: 'acct-1',
      snapshotConfigHome: WORK_HOME,
      currentConfigHome: WORK_HOME,
    })
  })

  it('projects a disabled profile row — restore keeps the historical identity (§38)', () => {
    const profile: AgentAccountProfile = {
      id: 'acct-1',
      agentId: 'codex',
      name: 'Codex Work',
      authType: 'subscription',
      runtime: UBUNTU,
      configHome: WORK_HOME,
      status: 'ready',
      enabled: false,
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
    }
    const projected = projectHistoricalProfileIdentity({
      run: snapshotRun(),
      profile,
      adapter,
      runtime: FAKE_RUNTIME,
      workspaceRuntime: UBUNTU,
    })
    expect(projected.ok).toBe(true)
    if (!projected.ok) return
    expect(projected.data.env).toEqual({ CODEX_HOME: WORK_HOME })
  })

  it('errors when neither the snapshot nor the row can name a configHome — never a silent account switch', () => {
    const projected = projectHistoricalProfileIdentity({
      run: snapshotRun({ profileSnapshot: undefined }),
      profile: null,
      adapter,
      runtime: FAKE_RUNTIME,
      workspaceRuntime: UBUNTU,
    })
    expect(projected.ok).toBe(false)
    if (projected.ok) return
    expect(projected.error.code).toBe('ACCOUNT_PROFILE_NOT_FOUND')
  })

  it('falls back to the profile row configHome when the snapshot lacks one', () => {
    const profile: AgentAccountProfile = {
      id: 'acct-1',
      agentId: 'codex',
      name: 'Codex Work',
      authType: 'external',
      runtime: UBUNTU,
      configHome: WORK_HOME,
      status: 'unknown',
      enabled: true,
      createdAt: '2026-09-12T00:00:00.000Z',
      updatedAt: '2026-09-12T00:00:00.000Z',
    }
    const projected = projectHistoricalProfileIdentity({
      run: snapshotRun({ profileSnapshot: { accountProfileId: 'acct-1' } }),
      profile,
      adapter,
      runtime: FAKE_RUNTIME,
      workspaceRuntime: UBUNTU,
    })
    expect(projected.ok).toBe(true)
    if (!projected.ok) return
    expect(projected.data.env).toEqual({ CODEX_HOME: WORK_HOME })
    expect(projected.data.resumeProfileContext.snapshotConfigHome).toBeUndefined()
    expect(projected.data.resumeProfileContext.currentConfigHome).toBe(WORK_HOME)
  })
})
