import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentDetectionResult,
  AgentRun,
  IpcResult,
  WorkbenchEvents,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'

import { createConfigService } from '../config/config-service'
import { migrateDatabase } from '../db/migrations'
import {
  createAccountEventRepository,
  createAccountProfileRepository,
  createAgentEventRepository,
  createAgentRunRepository,
  createHandoffRepository,
  createTaskRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createTeskraPaths } from '../paths'
import type { ProcessStartRequest } from '../process/process-manager'
import type { WorkspaceRuntime } from '../workspace/runtime'
import { createFakeAgentAdapter } from './adapters/fake-agent-adapter'
import { createCodexFailureClassifier } from './adapters/codex-failure-classifier'
import { createAgentManager, type AgentManager } from './agent-manager'
import { createAgentRegistry } from './agent-registry'
import { FAKE_AGENT } from './definitions/fake'
import { createRunLogStore } from './run-log-store'
import { createAccountProfileAdapterRegistry } from './accounts/account-profile-adapter'
import {
  createAccountProfileManager,
  type AccountProfileManager,
} from './accounts/account-profile-manager'
import {
  createAccountProfileStatusService,
  type AccountProfileStatusService,
} from './accounts/account-profile-status-service'

/**
 * TASK-105 (§17 / §56.3) — Agent Run failure classification end to end:
 * Fake Agent scenario output → AgentManager → classifier →
 * agent_runs.failure_classification_json, including the §17.0 negative case
 * (matching text while the process RUNS must not terminate or reclassify
 * anything) and the restart read-back.
 *
 * Uses the REAL Fake Agent adapter with a fake ProcessManager: the scenario
 * JSON files drive the emitted output/exit, so the test stays in lockstep
 * with what tools/fake-agent.js would print.
 */

const UBUNTU: WorkspaceRuntimeRef = { kind: 'wsl', distro: 'ubuntu-22.04' }
const SCENARIOS = fileURLToPath(
  new URL('../../../../../tools/fake-agent-scenarios', import.meta.url),
)
const FAKE_SCRIPT = fileURLToPath(new URL('../../../../../tools/fake-agent.js', import.meta.url))
const FAKE_HOME = '/home/u/.teskra/agent-profiles/fake/work'

interface ScenarioFile {
  readonly stdout?: readonly string[]
  readonly stderr?: readonly string[]
  readonly exitCode?: number
}

function loadScenario(name: string): ScenarioFile {
  return JSON.parse(readFileSync(join(SCENARIOS, `${name}.json`), 'utf8')) as ScenarioFile
}

const databases: Database.Database[] = []
const directories: string[] = []
const managers: AgentManager[] = []
const statusServices: AccountProfileStatusService[] = []

afterEach(async () => {
  for (const service of statusServices.splice(0)) service.dispose()
  for (const manager of managers.splice(0)) await manager.dispose()
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

const FAKE_RUNTIME = { ref: UBUNTU } as unknown as WorkspaceRuntime

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
  readonly directory: string
  readonly databaseFile: string
  readonly connection: Database.Database
  readonly events: EventBus<WorkbenchEvents>
  readonly manager: AgentManager
  readonly accountProfiles: AccountProfileManager
  readonly processes: CapturedProcesses
  readonly profiles: ReturnType<typeof createAccountProfileRepository>
  readonly accountEvents: ReturnType<typeof createAccountEventRepository>
}

function setup(options: { withClassifiers?: boolean } = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-task105-'))
  directories.push(directory)
  const databaseFile = join(directory, 'teskra.db')
  const paths = createTeskraPaths({ TESKRA_HOME: join(directory, 'data') })

  const connection = new Database(databaseFile)
  connection.pragma('foreign_keys = ON')
  requireOk(migrateDatabase(connection))
  databases.push(connection)

  const workspaces = createWorkspaceRepository(connection)
  const tasks = createTaskRepository(connection)
  const runs = createAgentRunRepository(connection)
  const agentEvents = createAgentEventRepository(connection)
  const handoffs = createHandoffRepository(connection)
  const worktrees = createWorktreeRepository(connection)
  const profiles = createAccountProfileRepository(connection)
  const accountEvents = createAccountEventRepository(connection)
  requireOk(
    workspaces.create(
      { id: 'workspace-1', name: 'Demo', runtime: UBUNTU, path: '/repo' },
      '2026-09-12T00:00:00.000Z',
    ),
  )

  const registry = requireOk(createAgentRegistry([FAKE_AGENT]))
  const events = createEventBus<WorkbenchEvents>()
  const config = createConfigService({ paths, workspaces })
  const resolveRuntime = (): IpcResult<WorkspaceRuntime> => ({ ok: true, data: FAKE_RUNTIME })

  // A minimal account-profile adapter for the fake agent: projection only.
  const profileAdapters = requireOk(
    createAccountProfileAdapterRegistry([
      {
        agentId: FAKE_AGENT.id,
        reservedEnvKeys: [],
        buildRuntimeProjection: () => ({ ok: true as const, data: { env: {} } }),
        detectStatus: () =>
          Promise.resolve({
            ok: true as const,
            data: { status: 'unknown' },
          }),
        buildLoginCommand: () => ({
          ok: true as const,
          data: { command: 'node', args: [FAKE_SCRIPT, '--scenario', 'success'] },
        }),
      },
    ]),
  )
  const accountProfiles = createAccountProfileManager({
    profiles,
    runs,
    registry,
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
      data: {
        agentId,
        runtime: UBUNTU,
        installed: true,
        executable: agentId,
        version: 'test',
        overridden: false,
        fromCache: false,
        checkedAt: '2026-09-12T00:00:00.000Z',
      } satisfies AgentDetectionResult,
    })),
    getExecutableOverride: vi.fn(() => ({ ok: true as const, data: null })),
  }
  const fakeAdapter = createFakeAgentAdapter({
    processes: processes.adapter,
    detector,
    resolveRuntime,
    scriptPath: FAKE_SCRIPT,
  })

  let nextRun = 1
  const manager = createAgentManager({
    registry,
    adapters: [fakeAdapter],
    runs,
    agentEvents,
    accountEvents,
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
    ...(options.withClassifiers === false
      ? {}
      : {
          // The REAL Codex classifier, keyed to the fake agent (§56.3
          // "fake-codex-rate-limit": scenario realism without burning quota).
          failureClassifiers: [{ ...createCodexFailureClassifier(), agentId: FAKE_AGENT.id }],
        }),
  })
  managers.push(manager)
  // TASK-106 (§18): the same projection the production compose wires —
  // terminal Run outcomes land on the account profile via the EventBus.
  const profileStatus = createAccountProfileStatusService({
    profiles,
    runs,
    events,
    accountEvents,
    now: () => '2026-09-12T00:00:02.000Z',
  })
  profileStatus.start()
  statusServices.push(profileStatus)
  return {
    directory,
    databaseFile,
    connection,
    events,
    manager,
    accountProfiles,
    processes,
    profiles,
    accountEvents,
  }
}

/** Replay a scenario file through the ProcessManager event stream. */
function emitScenario(
  fixture: Fixture,
  runId: string,
  scenario: ScenarioFile,
  options: { exit?: boolean } = {},
): void {
  const start = fixture.processes.starts.find((candidate) => candidate.agentRunId === runId)
  if (start === undefined) throw new Error(`no process started for ${runId}`)
  for (const line of scenario.stdout ?? []) {
    fixture.events.emit('process.output', {
      processId: start.id,
      agentRunId: runId,
      data: `${line}\n`,
    })
  }
  for (const line of scenario.stderr ?? []) {
    fixture.events.emit('process.output', {
      processId: start.id,
      agentRunId: runId,
      data: `${line}\n`,
    })
  }
  if (options.exit !== false) {
    fixture.events.emit('process.exited', {
      processId: start.id,
      agentRunId: runId,
      exitCode: scenario.exitCode ?? 0,
    })
  }
}

function runOf(fixture: Fixture, runId: string): AgentRun {
  const run = requireOk(fixture.manager.get(runId))
  if (run === null) throw new Error(`run ${runId} missing`)
  return run
}

async function startWithProfile(fixture: Fixture): Promise<{ runId: string; profileId: string }> {
  const profile = requireOk(
    await fixture.accountProfiles.create({
      agentId: FAKE_AGENT.id,
      name: 'Fake Work',
      authType: 'external',
      runtime: UBUNTU,
      configHome: FAKE_HOME,
    }),
  )
  const started = requireOk(
    await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: FAKE_AGENT.id,
      accountProfileId: profile.id,
    }),
  )
  return { runId: started.id, profileId: profile.id }
}

describe('Agent failure classification (TASK-105, §17 / §56.3)', () => {
  it('fake-codex-rate-limit: Run failed + classification + Profile limited, all persisted across restart', async () => {
    const fixture = setup()
    const { runId, profileId } = await startWithProfile(fixture)

    emitScenario(fixture, runId, loadScenario('rate-limit'))

    const run = runOf(fixture, runId)
    expect(run.status).toBe('failed')
    expect(run.exitCode).toBe(1)
    expect(run.failureClassification).toEqual({
      kind: 'rate-limited',
      retryable: true,
      resetAt: '2026-10-01T00:00:00.000Z',
      evidence: 'Error: rate limit reached for this account',
    })
    // §56.3: the same failure projected the profile to limited + limitedUntil.
    const profile = requireOk(fixture.profiles.getById(profileId))
    expect(profile?.status).toBe('limited')
    expect(profile?.limitedUntil).toBe('2026-10-01T00:00:00.000Z')

    // §17.2 / §56.3: after a full restart (fresh connection over the same
    // database file) BOTH the classification and the profile state read back.
    fixture.connection.close()
    const reopened = new Database(fixture.databaseFile, { readonly: true })
    try {
      const runs = createAgentRunRepository(reopened)
      const restored = requireOk(runs.getById(runId))
      expect(restored?.status).toBe('failed')
      expect(restored?.failureClassification).toEqual(run.failureClassification)
      const restoredProfile = requireOk(createAccountProfileRepository(reopened).getById(profileId))
      expect(restoredProfile?.status).toBe('limited')
      expect(restoredProfile?.limitedUntil).toBe('2026-10-01T00:00:00.000Z')
    } finally {
      reopened.close()
    }
  })

  it('negative (§17.0): quota text while RUNNING kills nothing and changes no profile state', async () => {
    const fixture = setup()
    const { runId, profileId } = await startWithProfile(fixture)
    const scenario = loadScenario('quota-mention')

    // The process is still running when the matching text appears: no kill,
    // no classification, no profile status change — at most a weak signal.
    emitScenario(fixture, runId, scenario, { exit: false })
    let run = runOf(fixture, runId)
    expect(run.status).toBe('running')
    expect(run.failureClassification).toBeUndefined()
    expect(requireOk(fixture.profiles.getById(profileId))?.status).toBe('unknown')

    // …and a clean exit afterwards is just a completed Run (whose §18
    // projection to `ready` is the legitimate writer of that status).
    fixture.events.emit('process.exited', {
      processId: fixture.processes.starts.find((start) => start.agentRunId === runId)?.id ?? '',
      agentRunId: runId,
      exitCode: scenario.exitCode ?? 0,
    })
    run = runOf(fixture, runId)
    expect(run.status).toBe('completed')
    expect(run.failureClassification).toBeUndefined()
    expect(requireOk(fixture.profiles.getById(profileId))?.status).toBe('ready')
  })

  it('without a registered classifier the Run still fails, with a NULL classification (best-effort metadata)', async () => {
    const fixture = setup({ withClassifiers: false })
    const { runId } = await startWithProfile(fixture)

    emitScenario(fixture, runId, loadScenario('rate-limit'))

    const run = runOf(fixture, runId)
    expect(run.status).toBe('failed')
    expect(run.failureClassification).toBeUndefined()
  })
})

describe('Account audit events (TASK-116, §41)', () => {
  it('agent.profile_selected records the resolved account identity for the run', async () => {
    const fixture = setup()
    const { runId, profileId } = await startWithProfile(fixture)

    const selected = requireOk(fixture.accountEvents.listByType('agent.profile_selected'))
    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({
      profileId,
      runId,
      eventType: 'agent.profile_selected',
      payload: {
        agentType: FAKE_AGENT.id,
        accountProfileId: profileId,
        accountProfileName: 'Fake Work',
        source: 'explicit',
      },
    })
  })

  it('a legacy start (no profile) writes no agent.profile_selected event', async () => {
    const fixture = setup()
    const started = requireOk(
      await fixture.manager.start({ workspaceId: 'workspace-1', agentType: FAKE_AGENT.id }),
    )
    expect(started.status).toBe('running')
    expect(requireOk(fixture.accountEvents.listByType('agent.profile_selected'))).toEqual([])
  })

  it('agent.rate_limited and account.status_changed are written on a rate-limited failure', async () => {
    const fixture = setup()
    const { runId, profileId } = await startWithProfile(fixture)

    emitScenario(fixture, runId, loadScenario('rate-limit'))

    const rateLimited = requireOk(fixture.accountEvents.listByType('agent.rate_limited'))
    expect(rateLimited).toHaveLength(1)
    expect(rateLimited[0]).toMatchObject({
      profileId,
      runId,
      eventType: 'agent.rate_limited',
      payload: {
        agentType: FAKE_AGENT.id,
        accountProfileId: profileId,
        retryable: true,
        resetAt: '2026-10-01T00:00:00.000Z',
      },
    })
    // The §18 projection (limited + limitedUntil) is audited too.
    const statusChanges = requireOk(
      fixture.accountEvents.listByType('account.status_changed'),
    ).filter((event) => event.profileId === profileId)
    expect(statusChanges).toHaveLength(1)
    expect(statusChanges[0]?.payload).toMatchObject({
      status: 'limited',
      previousStatus: 'unknown',
    })
  })

  it('a non-rate-limit failure writes no agent.rate_limited event', async () => {
    const fixture = setup()
    const { runId } = await startWithProfile(fixture)

    emitScenario(fixture, runId, loadScenario('fail'))

    expect(runOf(fixture, runId).status).toBe('failed')
    expect(requireOk(fixture.accountEvents.listByType('agent.rate_limited'))).toEqual([])
  })
})
