import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentAccountProfile,
  AgentDetectionResult,
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
  createHandoffRepository,
  createTaskRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
  type AccountProfileRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createTeskraPaths, type TeskraPaths } from '../paths'
import type { CommandRunner } from '../process/command-runner'
import type { ProcessStartRequest } from '../process/process-manager'
import type { WorkspaceRuntime } from '../workspace/runtime'
import { createCodexAdapter } from '../agents/adapters/codex-adapter'
import { createAgentManager, type AgentManager } from '../agents/agent-manager'
import { createBuiltInAgentRegistry } from '../agents/agent-registry'
import { createRunLogStore, type RunLogStore } from '../agents/run-log-store'
import { createAccountProfileAdapterRegistry } from '../agents/accounts/account-profile-adapter'
import {
  createAccountProfileManager,
  type AccountProfileManager,
} from '../agents/accounts/account-profile-manager'
import { createCodexAccountProfileAdapter } from '../agents/accounts/adapters/codex-account-profile-adapter'
import { createReconciliationService } from './reconciliation-service'
import { createResumeService } from './resume-service'

/**
 * TASK-112 — Profile-aware Recovery (Milestone 24 §38).
 *
 * Full crash loop against the real recovery entry points: a run launched
 * with an account profile goes down with the app, startup reconciliation
 * marks it interrupted, and the Recovery-driven resume (ResumeService →
 * AgentManager) must relaunch it with the HISTORICAL runtime identity —
 * never the current default profile.
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

const RUNTIME: WorkspaceRuntime = {
  ref: UBUNTU,
  hostNative: true,
  resolveCommand: (command, args = []) => ({ command, args: [...args] }) as never,
  resolveTerminal: () => {
    throw new Error('unused in these tests')
  },
  resolveCwd: (path) => path,
  resolveHostPath: (path) => ({ ok: true, data: path }),
  resolveDataRoot: () => '/data',
  resolveAgentProfilesRoot: () => '/data/agent-profiles',
  resolveAgentProfileHome: () => ({
    ok: false,
    error: { code: 'UNKNOWN', message: 'unused', retryable: false },
  }),
  validate: () => ({ ok: true, data: { kind: 'wsl', hostNative: true } }),
}

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

interface Fixture {
  readonly connection: Database.Database
  readonly events: EventBus<WorkbenchEvents>
  readonly paths: TeskraPaths
  readonly runLogs: RunLogStore
  readonly accountProfiles: AccountProfileManager
  readonly profiles: AccountProfileRepository
  readonly runs: ReturnType<typeof createAgentRunRepository>
  readonly agentEvents: ReturnType<typeof createAgentEventRepository>
  readonly workspaces: ReturnType<typeof createWorkspaceRepository>
  readonly worktrees: ReturnType<typeof createWorktreeRepository>
  readonly tasks: ReturnType<typeof createTaskRepository>
  readonly starts: ProcessStartRequest[]
  readonly newAgentManager: () => AgentManager
  readonly reconcile: () => Promise<void>
  readonly resumeViaRecovery: (runId: string) => ReturnType<AgentManager['resume']>
}

function setup(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-task112-'))
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
  const profiles = createAccountProfileRepository(connection)
  requireOk(
    workspaces.create(
      { id: 'workspace-1', name: 'Demo', runtime: UBUNTU, path: '/repo' },
      '2026-09-12T00:00:00.000Z',
    ),
  )

  const registry = createBuiltInAgentRegistry()
  if (!registry.ok) throw new Error('expected Agent Registry')
  const events = createEventBus<WorkbenchEvents>()
  const config = createConfigService({ paths, workspaces })
  const runLogs = createRunLogStore({ paths })
  const resolveRuntime = (): IpcResult<WorkspaceRuntime> => ({ ok: true, data: RUNTIME })

  const profileAdapters = requireOk(
    createAccountProfileAdapterRegistry([
      createCodexAccountProfileAdapter({ createRuntime: resolveRuntime }),
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

  const starts: ProcessStartRequest[] = []
  const processes = {
    list: () => [],
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
  }
  const detector = {
    detect: vi.fn(async ({ agentId }: { agentId: string }) => ({
      ok: true as const,
      data: detection(agentId),
    })),
    getExecutableOverride: vi.fn(() => ({ ok: true as const, data: null })),
  }

  let nextRun = 1
  // A fresh manager per "app instance" — recovery always runs on a NEW
  // AgentManager whose in-process state is empty, like a real restart.
  const newAgentManager = (): AgentManager => {
    const manager = createAgentManager({
      registry: registry.data,
      adapters: [createCodexAdapter({ processes, detector, resolveRuntime })],
      runs,
      agentEvents,
      handoffs,
      workspaces,
      tasks,
      worktrees,
      events,
      paths,
      runLogs,
      createRunId: () => `run-${String(nextRun++)}`,
      now: () => '2026-09-12T00:00:02.000Z',
      accountProfiles,
      resolveRuntime,
    })
    managers.push(manager)
    return manager
  }

  const commands = {
    run: () => {
      throw new Error('no commands are expected in these scenarios')
    },
  } as unknown as CommandRunner

  const reconcile = async (): Promise<void> => {
    const service = createReconciliationService({
      runs,
      agentEvents,
      workspaces,
      worktrees,
      tasks,
      processes,
      commands,
      events,
      runLogs,
      resolveRuntime: () => ({ ok: true, data: RUNTIME }),
      pathExists: () => false,
      now: () => '2026-09-12T00:00:05.000Z',
    })
    requireOk(await service.reconcile())
  }

  const resumeViaRecovery = (runId: string): ReturnType<AgentManager['resume']> => {
    const service = createResumeService({
      runs,
      workspaces,
      worktrees,
      processes,
      git: {
        branch: () =>
          Promise.resolve({
            ok: true as const,
            data: { current: 'main', detached: false, branches: ['main'] },
          }),
      },
      agentManager: newAgentManager(),
      resolveRuntime: () => ({ ok: true, data: RUNTIME }),
      pathExists: () => true,
    })
    return service.resume({ runId })
  }

  return {
    connection,
    events,
    paths,
    runLogs,
    accountProfiles,
    profiles,
    runs,
    agentEvents,
    workspaces,
    worktrees,
    tasks,
    starts,
    newAgentManager,
    reconcile,
    resumeViaRecovery,
  }
}

async function createWorkProfile(fixture: Fixture): Promise<AgentAccountProfile> {
  return requireOk(
    await fixture.accountProfiles.create({
      agentId: 'codex',
      name: 'Codex Work',
      authType: 'external',
      runtime: UBUNTU,
      configHome: WORK_HOME,
    }),
  )
}

/** Launch run-1 with the Work profile and a recorded Codex session. */
async function startWorkRun(fixture: Fixture): Promise<AgentAccountProfile> {
  const work = await createWorkProfile(fixture)
  const started = await fixture.newAgentManager().start({
    workspaceId: 'workspace-1',
    agentType: 'codex',
    accountProfileId: work.id,
    prompt: 'Implement',
  })
  expect(started).toMatchObject({ ok: true, data: { id: 'run-1', status: 'running' } })
  const session = fixture.runs.update('run-1', {
    providerSession: { provider: 'codex', sessionId: 'sess-work' },
  })
  if (!session.ok) throw new Error(session.error.message)
  return work
}

async function switchDefaultToPersonal(fixture: Fixture): Promise<void> {
  const personal = requireOk(
    await fixture.accountProfiles.create({
      agentId: 'codex',
      name: 'Codex Personal',
      authType: 'external',
      runtime: UBUNTU,
      configHome: PERSONAL_HOME,
    }),
  )
  requireOk(await fixture.accountProfiles.setDefault('codex', personal.id))
}

describe('Profile-aware Recovery (TASK-112, §38)', () => {
  it('crash → default changed → recovery still projects the historical CODEX_HOME', async () => {
    const fixture = setup()
    const work = await startWorkRun(fixture)
    await switchDefaultToPersonal(fixture)

    // The app goes down and restarts: startup reconciliation interrupts the run.
    await fixture.reconcile()
    const interrupted = requireOk(fixture.runs.getById('run-1'))
    expect(interrupted?.status).toBe('interrupted')
    // Reconciliation must not clobber the recorded identity.
    expect(interrupted?.accountProfileId).toBe(work.id)
    expect(interrupted?.profileSnapshot?.configHome).toBe(WORK_HOME)

    const resumed = await fixture.resumeViaRecovery('run-1')

    expect(resumed).toMatchObject({ ok: true, data: { status: 'running' } })
    const relaunch = fixture.starts[1]
    expect(relaunch?.env?.CODEX_HOME).toBe(WORK_HOME)
    expect(relaunch?.args).toContain('sess-work')
    expect(relaunch?.args).not.toContain('--last')
  })

  it('profile row deleted after the crash → recovery projects the snapshot (snapshot is the truth)', async () => {
    const fixture = setup()
    const work = await startWorkRun(fixture)
    await fixture.reconcile()
    requireOk(fixture.profiles.delete(work.id))

    const resumed = await fixture.resumeViaRecovery('run-1')

    expect(resumed).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(fixture.starts[1]?.env?.CODEX_HOME).toBe(WORK_HOME)
  })

  it('profile disabled after the crash → user-driven resume is REFUSED (ACCOUNT_PROFILE_DISABLED, §65 G); use Continuation instead', async () => {
    const fixture = setup()
    const work = await startWorkRun(fixture)
    await fixture.reconcile()
    // The run is interrupted (terminal), so soft-disable is allowed.
    requireOk(await fixture.accountProfiles.remove(work.id))

    const resumed = await fixture.resumeViaRecovery('run-1')

    expect(resumed.ok).toBe(false)
    if (resumed.ok) return
    expect(resumed.error.code).toBe('ACCOUNT_PROFILE_DISABLED')
    expect(resumed.error.message).toContain('Continuation')
    // No relaunch happened and the run keeps its resumable status.
    expect(fixture.starts).toHaveLength(1)
    expect(requireOk(fixture.runs.getById('run-1'))?.status).toBe('interrupted')
  })

  it('workspace re-pointed at another runtime after the crash → resume is refused (ACCOUNT_PROFILE_INCOMPATIBLE)', async () => {
    const fixture = setup()
    await startWorkRun(fixture)
    await fixture.reconcile()
    // The workspace now runs natively on Windows while the run's historical
    // identity is WSL — resuming would inject a WSL config home into a
    // Windows process (or vice versa) and the CLI would silently fall back
    // to its default home (P1-4).
    requireOk(
      fixture.workspaces.update(
        'workspace-1',
        { runtime: { kind: 'windows' } },
        '2026-09-12T00:00:04.000Z',
      ),
    )

    const resumed = await fixture.resumeViaRecovery('run-1')

    expect(resumed.ok).toBe(false)
    if (resumed.ok) return
    expect(resumed.error.code).toBe('ACCOUNT_PROFILE_INCOMPATIBLE')
    expect(fixture.starts).toHaveLength(1)
    expect(requireOk(fixture.runs.getById('run-1'))?.status).toBe('interrupted')
  })

  it('workspace.env carrying a reserved account key after the crash → resume is rejected (§13.2, same as start)', async () => {
    const fixture = setup()
    await startWorkRun(fixture)
    await fixture.reconcile()
    requireOk(
      fixture.workspaces.update(
        'workspace-1',
        { env: { CODEX_HOME: '/attacker-controlled' } },
        '2026-09-12T00:00:04.000Z',
      ),
    )

    const resumed = await fixture.resumeViaRecovery('run-1')

    expect(resumed.ok).toBe(false)
    if (resumed.ok) return
    expect(resumed.error.code).toBe('VALIDATION_FAILED')
    expect(resumed.error.message).toContain('CODEX_HOME')
    expect(fixture.starts).toHaveLength(1)
    expect(requireOk(fixture.runs.getById('run-1'))?.status).toBe('interrupted')
  })

  it('snapshot missing AND profile row gone → recovery errors instead of silently switching accounts', async () => {
    const fixture = setup()
    const work = await createWorkProfile(fixture)
    // A run row that carries the weak reference but no snapshot (anomaly).
    requireOk(
      fixture.runs.create(
        {
          id: 'run-9',
          workspaceId: 'workspace-1',
          agentType: 'codex',
          executionMode: 'attended',
          runDir: requireOk(fixture.paths.runDir('run-9')),
          status: 'interrupted',
          accountProfileId: work.id,
        },
        '2026-09-12T00:00:00.000Z',
      ),
    )
    requireOk(fixture.profiles.delete(work.id))

    const resumed = await fixture.resumeViaRecovery('run-9')

    expect(resumed.ok).toBe(false)
    if (resumed.ok) return
    expect(resumed.error.code).toBe('ACCOUNT_PROFILE_NOT_FOUND')
    expect(resumed.error.message).toContain('Continuation')
    expect(fixture.starts).toHaveLength(0)
    // The run was NOT relaunched under another identity.
    expect(requireOk(fixture.runs.getById('run-9'))?.status).toBe('interrupted')
  })

  it('legacy run (no profile identity) recovers WITHOUT projecting the current default', async () => {
    const fixture = setup()
    const started = await fixture.newAgentManager().start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      prompt: 'Implement',
    })
    expect(started).toMatchObject({ ok: true, data: { id: 'run-1', status: 'running' } })
    const session = fixture.runs.update('run-1', {
      providerSession: { provider: 'codex', sessionId: 'sess-legacy' },
    })
    if (!session.ok) throw new Error(session.error.message)
    await switchDefaultToPersonal(fixture)
    await fixture.reconcile()

    const resumed = await fixture.resumeViaRecovery('run-1')

    expect(resumed).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(fixture.starts[1]?.env).not.toHaveProperty('CODEX_HOME')
  })
})
