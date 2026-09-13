import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentAccountProfile,
  AgentDetectionResult,
  AgentExecutionProfile,
  AgentRun,
  IpcResult,
  WorkbenchEvents,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'

import { createConfigService } from '../config/config-service'
import { migrateDatabase } from '../db/migrations'
import {
  createAccountProfileRepository,
  createAgentEventRepository,
  createAgentRunRepository,
  createExecutionProfileRepository,
  createHandoffRepository,
  createTaskRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
  type ExecutionProfileRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createTeskraPaths, type TeskraPaths } from '../paths'
import type { ProcessStartRequest } from '../process/process-manager'
import type { WorkspaceRuntime } from '../workspace/runtime'
import { createCodexAdapter } from './adapters/codex-adapter'
import { createAgentManager, type AgentManager } from './agent-manager'
import { createBuiltInAgentRegistry } from './agent-registry'
import { createRunLogStore } from './run-log-store'
import { createAccountProfileAdapterRegistry } from './accounts/account-profile-adapter'
import {
  createAccountProfileManager,
  type AccountProfileManager,
} from './accounts/account-profile-manager'
import { createClaudeAccountProfileAdapter } from './accounts/adapters/claude-account-profile-adapter'
import { createCodexAccountProfileAdapter } from './accounts/adapters/codex-account-profile-adapter'
import {
  createExecutionProfileManager,
  type ExecutionProfileManager,
} from './execution-profiles/execution-profile-manager'

/**
 * TASK-110 — AgentManager execution profile integration (Milestone 24
 * §6.1/§14). Same harness as the TASK-100 account tests: the REAL Codex CLI
 * adapter over a fake ProcessManager, the real Account/Execution profile
 * managers and repositories, so run-row snapshots and the launch env are
 * read back through the production code path.
 */

const UBUNTU: WorkspaceRuntimeRef = { kind: 'wsl', distro: 'ubuntu-22.04' }
const WORK_HOME = '/home/u/.teskra/agent-profiles/codex/work'
const PERSONAL_HOME = '/home/u/.teskra/agent-profiles/codex/personal'

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
  readonly executionProfiles: ExecutionProfileManager
  readonly profiles: ExecutionProfileRepository
  readonly runs: ReturnType<typeof createAgentRunRepository>
  readonly workspaces: ReturnType<typeof createWorkspaceRepository>
  readonly processes: CapturedProcesses
  readonly paths: TeskraPaths
}

function setup(options: { withExecutionProfiles?: boolean } = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-task110-'))
  directories.push(directory)
  const paths = createTeskraPaths({ TESKRA_HOME: join(directory, 'data') })

  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  databases.push(connection)

  const workspaces = createWorkspaceRepository(connection)
  const tasks = createTaskRepository(connection)
  const runs = createAgentRunRepository(connection)
  const agentEvents = createAgentEventRepository(connection)
  const handoffs = createHandoffRepository(connection)
  const worktrees = createWorktreeRepository(connection)
  const accountProfileRows = createAccountProfileRepository(connection)
  const profiles = createExecutionProfileRepository(connection)
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
    profiles: accountProfileRows,
    runs,
    registry: registry.data,
    paths,
    config,
    events,
    adapters: profileAdapters,
    createRuntime: resolveRuntime,
  })
  const executionProfiles = createExecutionProfileManager({
    profiles,
    accountProfiles: accountProfileRows,
    registry: registry.data,
    config,
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
    accountProfiles,
    resolveRuntime,
    ...(options.withExecutionProfiles === false ? {} : { executionProfiles }),
  })
  managers.push(manager)
  return {
    connection,
    events,
    manager,
    accountProfiles,
    executionProfiles,
    profiles,
    runs,
    workspaces,
    processes,
    paths,
  }
}

function envOf(fixture: Fixture, index = 0): Readonly<Record<string, string>> {
  const env = fixture.processes.starts[index]?.env
  if (env === undefined) throw new Error('expected a launched process')
  return env
}

async function createAccount(
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

async function createProfile(
  fixture: Fixture,
  overrides: Partial<Parameters<ExecutionProfileManager['create']>[0]> = {},
): Promise<AgentExecutionProfile> {
  return requireOk(
    await fixture.executionProfiles.create({
      agentId: 'codex',
      name: 'Codex Personal High',
      ...overrides,
    }),
  )
}

function runOf(fixture: Fixture, runId: string): AgentRun {
  const run = requireOk(fixture.runs.getById(runId))
  if (run === null) throw new Error(`expected run ${runId}`)
  return run
}

describe('AgentManager execution profile integration (TASK-110)', () => {
  it('start with executionProfileId takes model / approvalMode / account from the profile and snapshots everything (§14)', async () => {
    const fixture = setup()
    const work = await createAccount(fixture)
    const profile = await createProfile(fixture, {
      accountProfileId: work.id,
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
      approvalMode: 'read-only',
    })

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionProfileId: profile.id,
    })

    expect(started).toMatchObject({ ok: true, data: { status: 'running' } })
    // The account dimension resolved through the profile (§13.1 env slot).
    expect(envOf(fixture).CODEX_HOME).toBe(WORK_HOME)
    const run = runOf(fixture, 'run-1')
    expect(run).toMatchObject({
      accountProfileId: work.id,
      executionProfileId: profile.id,
      model: 'gpt-5-codex',
      approvalMode: 'read-only',
    })
    expect(run.profileSnapshot).toEqual({
      accountProfileId: work.id,
      accountProfileName: 'Codex Work',
      executionProfileId: profile.id,
      executionProfileName: 'Codex Personal High',
      runtime: UBUNTU,
      configHome: WORK_HOME,
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
    })
  })

  it('explicit request model / approvalMode win over the execution profile', async () => {
    const fixture = setup()
    const profile = await createProfile(fixture, {
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
      approvalMode: 'read-only',
    })

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionProfileId: profile.id,
      model: 'gpt-5-mini',
      approvalMode: 'full-auto',
    })

    expect(started.ok).toBe(true)
    const run = runOf(fixture, 'run-1')
    expect(run.model).toBe('gpt-5-mini')
    expect(run.approvalMode).toBe('full-auto')
    // The snapshot records the model AS RESOLVED (the explicit override).
    expect(run.profileSnapshot).toMatchObject({
      executionProfileId: profile.id,
      model: 'gpt-5-mini',
      reasoningEffort: 'high',
    })
  })

  it('rejects an execution profile belonging to another agent (EXECUTION_PROFILE_MISMATCH)', async () => {
    const fixture = setup()
    const profile = await createProfile(fixture, { agentId: 'claude', name: 'Claude High' })

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionProfileId: profile.id,
    })

    expect(started).toMatchObject({ ok: false, error: { code: 'EXECUTION_PROFILE_MISMATCH' } })
    expect(fixture.processes.starts).toHaveLength(0)
  })

  it('rejects a missing execution profile (EXECUTION_PROFILE_NOT_FOUND)', async () => {
    const fixture = setup()

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionProfileId: 'exec-gone',
    })

    expect(started).toMatchObject({ ok: false, error: { code: 'EXECUTION_PROFILE_NOT_FOUND' } })
    expect(fixture.processes.starts).toHaveLength(0)
  })

  it('explicit accountProfileId wins over the execution profile account; other fields still come from the profile (§14)', async () => {
    const fixture = setup()
    const work = await createAccount(fixture)
    const personal = await createAccount(fixture, {
      name: 'Codex Personal',
      configHome: PERSONAL_HOME,
    })
    const profile = await createProfile(fixture, {
      accountProfileId: work.id,
      model: 'gpt-5-codex',
      approvalMode: 'read-only',
    })

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionProfileId: profile.id,
      accountProfileId: personal.id,
    })

    expect(started.ok).toBe(true)
    expect(envOf(fixture).CODEX_HOME).toBe(PERSONAL_HOME)
    const run = runOf(fixture, 'run-1')
    expect(run.accountProfileId).toBe(personal.id)
    expect(run).toMatchObject({
      executionProfileId: profile.id,
      model: 'gpt-5-codex',
      approvalMode: 'read-only',
    })
    expect(run.profileSnapshot).toMatchObject({
      accountProfileId: personal.id,
      accountProfileName: 'Codex Personal',
      executionProfileId: profile.id,
      executionProfileName: 'Codex Personal High',
      model: 'gpt-5-codex',
    })
  })

  it('an execution profile without an account keeps the legacy CLI environment (no config dir env)', async () => {
    const fixture = setup()
    const profile = await createProfile(fixture, { model: 'gpt-5-codex' })

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionProfileId: profile.id,
    })

    expect(started.ok).toBe(true)
    const env = envOf(fixture)
    expect(env).not.toHaveProperty('CODEX_HOME')
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    const run = runOf(fixture, 'run-1')
    expect(run.accountProfileId).toBeUndefined()
    expect(run.executionProfileId).toBe(profile.id)
    expect(run.profileSnapshot).toEqual({
      executionProfileId: profile.id,
      executionProfileName: 'Codex Personal High',
      model: 'gpt-5-codex',
    })
  })

  it('legacy start (no profiles) stays byte-identical — no snapshot, no exec fields (§52)', async () => {
    const fixture = setup()
    await createProfile(fixture, { model: 'gpt-5-codex' })

    const started = await fixture.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })

    expect(started.ok).toBe(true)
    const run = runOf(fixture, 'run-1')
    expect(run.executionProfileId).toBeUndefined()
    expect(run.accountProfileId).toBeUndefined()
    expect(run.profileSnapshot).toBeUndefined()
    expect(run.model).toBeUndefined()
    expect(envOf(fixture)).not.toHaveProperty('CODEX_HOME')
  })

  it('rejects executionProfileId when no ExecutionProfileManager is composed', async () => {
    const fixture = setup({ withExecutionProfiles: false })

    const started = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionProfileId: 'exec-1',
    })

    expect(started).toMatchObject({ ok: false, error: { code: 'CAPABILITY_NOT_AVAILABLE' } })
    expect(fixture.processes.starts).toHaveLength(0)
  })

  it('continueWithProfile launches the target under the target execution profile — its model / approvalMode are NOT inherited from the source (§14/§19.3)', async () => {
    const fixture = setup()
    const work = await createAccount(fixture)
    const profile = await createProfile(fixture, {
      accountProfileId: work.id,
      model: 'gpt-5-codex',
      approvalMode: 'read-only',
    })
    // A terminal source run on the workspace (flow A — no process to stop).
    requireOk(
      fixture.runs.create(
        {
          id: 'run-source',
          workspaceId: 'workspace-1',
          agentType: 'codex',
          executionMode: 'attended',
          runDir: requireOk(fixture.paths.runDir('run-source')),
          status: 'failed',
          model: 'gpt-4',
          approvalMode: 'full-auto',
        },
        '2026-09-12T00:00:01.000Z',
      ),
    )

    const continued = await fixture.manager.continueWithProfile({
      sourceRunId: 'run-source',
      targetAgentId: 'codex',
      targetExecutionProfileId: profile.id,
    })

    expect(continued).toMatchObject({ ok: true, data: { status: 'running' } })
    const target = runOf(fixture, 'run-1')
    expect(target).toMatchObject({
      executionProfileId: profile.id,
      accountProfileId: work.id,
      model: 'gpt-5-codex',
      approvalMode: 'read-only',
    })
    expect(envOf(fixture).CODEX_HOME).toBe(WORK_HOME)
  })
})
