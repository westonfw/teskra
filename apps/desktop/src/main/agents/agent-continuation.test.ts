import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentAccountProfile,
  AgentDetectionResult,
  AgentRun,
  ConcurrencyConfig,
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
  createArtifactRepository,
  createCriteriaRepository,
  createHandoffRepository,
  createTaskRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createTeskraPaths } from '../paths'
import type { ProcessStartRequest, ProcessStopResult } from '../process/process-manager'
import type { WorkspaceRuntime } from '../workspace/runtime'
import { createFakeAgentAdapter } from './adapters/fake-agent-adapter'
import { createCodexFailureClassifier } from './adapters/codex-failure-classifier'
import { agentProcessId } from './adapters/cli-agent-adapter'
import { createAgentManager, type AgentManager } from './agent-manager'
import { createAgentRegistry } from './agent-registry'
import { FAKE_AGENT } from './definitions/fake'
import { createRunLogStore } from './run-log-store'
import { createAccountProfileAdapterRegistry } from './accounts/account-profile-adapter'
import {
  createAccountProfileManager,
  type AccountProfileManager,
} from './accounts/account-profile-manager'
import { buildAgentContinuation, buildContinuationPrompt } from './continuation-builder'

/**
 * TASK-107 (§19/§20/§21, §56.4) — Cross-profile Continuation: the two flows
 * (A: terminal source, B: fail-and-continue), the failAndStop idempotency
 * contract, the §19.5 "not found ≠ dead" survivor path, the one-live-run-per-
 * worktree invariant, and the §41 continuation audit events.
 */

const UBUNTU: WorkspaceRuntimeRef = { kind: 'wsl', distro: 'ubuntu-22.04' }
const SCENARIOS = fileURLToPath(
  new URL('../../../../../tools/fake-agent-scenarios', import.meta.url),
)
const FAKE_SCRIPT = fileURLToPath(new URL('../../../../../tools/fake-agent.js', import.meta.url))
const PERSONAL_HOME = '/home/u/.teskra/agent-profiles/fake/personal'
const WORK_HOME = '/home/u/.teskra/agent-profiles/fake/work'

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

const FAKE_RUNTIME = { ref: UBUNTU } as unknown as WorkspaceRuntime

type StopBehavior =
  | { readonly kind: 'exits'; readonly exitCode?: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'not-found' }

interface CapturedProcesses {
  readonly adapter: Pick<
    import('../process/process-manager').ProcessManager,
    'start' | 'write' | 'resize' | 'stop'
  >
  readonly starts: ProcessStartRequest[]
  readonly stops: string[]
  stopBehavior: StopBehavior
}

/**
 * stop() mirrors the real ProcessManager contract: a successful stop emits
 * process.exited BEFORE resolving (§19.4 — success means the process exited).
 */
function fakeProcesses(events: EventBus<WorkbenchEvents>): CapturedProcesses {
  const starts: ProcessStartRequest[] = []
  const stops: string[] = []
  const captured: CapturedProcesses = {
    starts,
    stops,
    stopBehavior: { kind: 'exits' },
    adapter: {
      start: (request: ProcessStartRequest) => {
        starts.push(request)
        return {
          ok: true as const,
          data: {
            id: request.id,
            pid: 4242,
            startedAt: '2026-09-12T00:00:01.000Z',
          },
        }
      },
      write: () => ({ ok: true as const, data: undefined }),
      resize: () => ({ ok: true as const, data: undefined }),
      stop: (processId: string) => {
        stops.push(processId)
        const behavior = captured.stopBehavior
        if (behavior.kind === 'timeout') {
          return Promise.resolve({
            ok: false as const,
            error: {
              code: 'COMMAND_TIMEOUT' as const,
              message: `Process "${processId}" did not exit after force kill.`,
              retryable: true,
            },
          })
        }
        if (behavior.kind === 'not-found') {
          return Promise.resolve({
            ok: false as const,
            error: {
              code: 'PROCESS_NOT_FOUND' as const,
              message: `Process "${processId}" is not active.`,
              retryable: false,
            },
          })
        }
        events.emit('process.exited', {
          processId,
          exitCode: behavior.exitCode ?? 1,
        })
        return Promise.resolve({
          ok: true as const,
          data: {
            exit: { processId, exitCode: behavior.exitCode ?? 1 },
            stage: 'terminate' as const,
          } satisfies ProcessStopResult,
        })
      },
    },
  }
  return captured
}

interface Fixture {
  readonly events: EventBus<WorkbenchEvents>
  readonly manager: AgentManager
  readonly accountProfiles: AccountProfileManager
  readonly processes: CapturedProcesses
  readonly runs: ReturnType<typeof createAgentRunRepository>
  readonly accountEvents: ReturnType<typeof createAccountEventRepository>
  readonly handoffs: ReturnType<typeof createHandoffRepository>
  readonly hostProcesses: {
    identity: ReturnType<typeof vi.fn>
    terminate: ReturnType<typeof vi.fn>
    probe: ReturnType<typeof vi.fn>
  }
}

function setup(options: { concurrency?: ConcurrencyConfig } = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-task107-'))
  directories.push(directory)
  const paths = createTeskraPaths({ TESKRA_HOME: join(directory, 'data') })

  const connection = new Database(':memory:')
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
  const artifacts = createArtifactRepository(connection)
  const criteria = createCriteriaRepository(connection)
  requireOk(
    workspaces.create(
      { id: 'workspace-1', name: 'Demo', runtime: UBUNTU, path: '/repo' },
      '2026-09-12T00:00:00.000Z',
    ),
  )
  requireOk(
    tasks.create(
      { id: 'task-1', workspaceId: 'workspace-1', title: 'TASK-218' },
      '2026-09-12T00:00:00.000Z',
    ),
  )
  requireOk(
    worktrees.create(
      {
        id: 'wt-1',
        workspaceId: 'workspace-1',
        branch: 'teskra/task-1',
        baseBranch: 'main',
        path: '/repo/.teskra/worktrees/wt-1',
        isolation: 'worktree',
        state: 'ready',
      },
      '2026-09-12T00:00:00.000Z',
    ),
  )

  const registry = requireOk(createAgentRegistry([FAKE_AGENT]))
  const events = createEventBus<WorkbenchEvents>()
  const config = createConfigService({ paths, workspaces })
  const resolveRuntime = (): IpcResult<WorkspaceRuntime> => ({ ok: true, data: FAKE_RUNTIME })

  const profileAdapters = requireOk(
    createAccountProfileAdapterRegistry([
      {
        agentId: FAKE_AGENT.id,
        reservedEnvKeys: [],
        buildRuntimeProjection: () => ({ ok: true as const, data: { env: {} } }),
        detectStatus: () => Promise.resolve({ ok: true as const, data: { status: 'unknown' } }),
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
    accountEvents,
    createRuntime: resolveRuntime,
  })

  const processes = fakeProcesses(events)
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
  const hostProcesses = {
    identity: vi.fn(async (): Promise<IpcResult<string | null>> => ({ ok: true, data: null })),
    terminate: vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined })),
    probe: vi.fn(async (): Promise<IpcResult<boolean>> => ({ ok: true, data: false })),
  }

  let nextRun = 1
  const concurrency = options.concurrency
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
    ...(concurrency === undefined
      ? {}
      : { resolveConcurrency: () => ({ ok: true as const, data: concurrency }) }),
    accountProfiles,
    resolveRuntime,
    hostProcesses: hostProcesses,
    processes: processes.adapter,
    artifacts,
    criteria,
    failureClassifiers: [{ ...createCodexFailureClassifier(), agentId: FAKE_AGENT.id }],
  })
  managers.push(manager)
  return {
    events,
    manager,
    accountProfiles,
    processes,
    runs,
    accountEvents,
    handoffs,
    hostProcesses,
  }
}

async function createProfile(
  fixture: Fixture,
  name: string,
  configHome: string,
): Promise<AgentAccountProfile> {
  return requireOk(
    await fixture.accountProfiles.create({
      agentId: FAKE_AGENT.id,
      name,
      authType: 'external',
      runtime: UBUNTU,
      configHome,
    }),
  )
}

function emitScenario(
  fixture: Fixture,
  runId: string,
  scenario: ScenarioFile,
  options: { exit?: boolean } = {},
): void {
  const start = fixture.processes.starts.find((candidate) => candidate.agentRunId === runId)
  if (start === undefined) throw new Error(`no process started for ${runId}`)
  for (const line of [...(scenario.stdout ?? []), ...(scenario.stderr ?? [])]) {
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

async function startSourceRun(fixture: Fixture, profileId: string): Promise<{ runId: string }> {
  const started = requireOk(
    await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: FAKE_AGENT.id,
      accountProfileId: profileId,
      taskId: 'task-1',
      worktreeId: 'wt-1',
      prompt: 'Implement TASK-218.',
    }),
  )
  return { runId: started.id }
}

describe('ContinuationBuilder (§20)', () => {
  it('builds the context package from the run, handoff, artifacts and criteria', () => {
    const continuation = buildAgentContinuation({
      sourceRun: {
        id: 'run-1',
        workspaceId: 'ws-1',
        taskId: 'task-1',
        worktreeId: 'wt-1',
        agentType: 'fake-agent',
        accountProfileId: 'acct-personal',
        executionMode: 'orchestrated',
        status: 'failed',
        runDir: '/tmp/run-1',
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:00.000Z',
      },
      reason: 'rate-limit',
      handoff: {
        id: 'ho-1',
        runId: 'run-1',
        type: 'implementation',
        payload: { summary: 'Half of the parser is done.', filesChanged: ['src/parser.ts'] },
        parseStatus: 'ok',
        createdAt: '2026-09-12T00:00:00.000Z',
      },
      artifactIds: ['art-1'],
      acceptanceCriteria: [{ id: 'c-1', description: 'Parser passes', required: true }],
      outputTail: 'some output',
    })
    expect(continuation).toEqual({
      sourceRunId: 'run-1',
      reason: 'rate-limit',
      taskId: 'task-1',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      summary: 'Half of the parser is done.',
      changedFiles: ['src/parser.ts'],
      artifactIds: ['art-1'],
      acceptanceCriteria: [{ id: 'c-1', description: 'Parser passes', required: true }],
      previousAgentId: 'fake-agent',
      previousAccountProfileId: 'acct-personal',
    })

    const prompt = buildContinuationPrompt(continuation, {
      originalPrompt: 'Implement TASK-218.',
      outputTail: 'line of output',
    })
    expect(prompt).toContain('Continue Teskra Run run-1')
    expect(prompt).toContain('rate-limit')
    expect(prompt).toContain('Original request:\nImplement TASK-218.')
    expect(prompt).toContain('Half of the parser is done.')
    expect(prompt).toContain('src/parser.ts')
    expect(prompt).toContain('art-1')
    expect(prompt).toContain('Parser passes')
    expect(prompt).toContain('line of output')
    expect(prompt).toContain('Inspect the current files before changing them')
  })

  it('falls back to the output tail when no handoff exists', () => {
    const continuation = buildAgentContinuation({
      sourceRun: {
        id: 'run-2',
        workspaceId: 'ws-1',
        agentType: 'fake-agent',
        executionMode: 'attended',
        status: 'failed',
        runDir: '/tmp/run-2',
        createdAt: '2026-09-12T00:00:00.000Z',
        updatedAt: '2026-09-12T00:00:00.000Z',
      },
      reason: 'manual-switch',
      handoff: null,
      outputTail: '  tail of the terminal  ',
    })
    expect(continuation.summary).toBe('tail of the terminal')
    expect(continuation.taskId).toBeUndefined()
    expect(continuation.worktreeId).toBeUndefined()
    expect(continuation.previousAccountProfileId).toBeUndefined()
  })
})

describe('failAndStop (§19.3/§19.4/§19.5)', () => {
  it('a running source is stopped and lands on failed + the registered classification (never cancelled)', async () => {
    const fixture = setup()
    const profile = await createProfile(fixture, 'Personal', PERSONAL_HOME)
    const { runId } = await startSourceRun(fixture, profile.id)
    expect(runOf(fixture, runId).status).toBe('running')

    const stopped = requireOk(
      await fixture.manager.failAndStop(runId, {
        kind: 'rate-limited',
        retryable: true,
        resetAt: '2026-10-01T00:00:00.000Z',
      }),
    )

    expect(fixture.processes.stops).toEqual([agentProcessId(runId)])
    expect(stopped.status).toBe('failed')
    expect(stopped.failureClassification).toEqual({
      kind: 'rate-limited',
      retryable: true,
      resetAt: '2026-10-01T00:00:00.000Z',
    })
    // The §41 rate-limit audit fired through the process.exited intent path.
    expect(requireOk(fixture.accountEvents.listByType('agent.rate_limited'))).toHaveLength(1)
  })

  it('idempotent on an already failed + classified run: success WITHOUT calling stop', async () => {
    const fixture = setup()
    const profile = await createProfile(fixture, 'Personal', PERSONAL_HOME)
    const { runId } = await startSourceRun(fixture, profile.id)
    emitScenario(fixture, runId, loadScenario('rate-limit'))
    expect(runOf(fixture, runId).failureClassification?.kind).toBe('rate-limited')
    const stopsBefore = fixture.processes.stops.length

    const stopped = requireOk(
      await fixture.manager.failAndStop(runId, { kind: 'unknown', retryable: true }),
    )

    expect(stopped.status).toBe('failed')
    expect(stopped.failureClassification?.kind).toBe('rate-limited')
    expect(fixture.processes.stops.length).toBe(stopsBefore)
  })

  it.each(['completed', 'cancelled', 'interrupted'] as const)(
    'rejects a %s source run — flow A territory, not flow B',
    async (terminalStatus) => {
      const fixture = setup()
      const profile = await createProfile(fixture, 'Personal', PERSONAL_HOME)
      const { runId } = await startSourceRun(fixture, profile.id)
      if (terminalStatus === 'completed') {
        emitScenario(fixture, runId, loadScenario('success'))
      } else if (terminalStatus === 'cancelled') {
        await fixture.manager.cancel(runId)
      } else {
        // interrupted rows are reconciliation-only; write one directly.
        requireOk(
          fixture.runs.update(
            runId,
            { status: 'interrupted', finishedAt: '2026-09-12T00:00:03.000Z' },
            '2026-09-12T00:00:03.000Z',
          ),
        )
      }
      expect(runOf(fixture, runId).status).toBe(terminalStatus)

      const result = await fixture.manager.failAndStop(runId, {
        kind: 'unknown',
        retryable: true,
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('VALIDATION_FAILED')
      expect(runOf(fixture, runId).status).toBe(terminalStatus)
    },
  )

  it('COMMAND_TIMEOUT means the process is still alive: abort and leave the run running', async () => {
    const fixture = setup()
    const profile = await createProfile(fixture, 'Personal', PERSONAL_HOME)
    const { runId } = await startSourceRun(fixture, profile.id)
    fixture.processes.stopBehavior = { kind: 'timeout' }

    const result = await fixture.manager.failAndStop(runId, {
      kind: 'rate-limited',
      retryable: true,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('COMMAND_TIMEOUT')
    const run = runOf(fixture, runId)
    expect(run.status).toBe('running')
    expect(run.failureClassification).toBeUndefined()
    // The intent was cleared: a later natural exit is classified normally
    // (the classifier, not the aborted intent, produces the classification).
    emitScenario(fixture, runId, loadScenario('rate-limit'))
    const finished = runOf(fixture, runId)
    expect(finished.status).toBe('failed')
    expect(finished.failureClassification?.evidence).toBe(
      'Error: rate limit reached for this account',
    )
  })

  it('not found + pid identity alive → the survivor is terminated, then the run settles failed', async () => {
    const fixture = setup()
    const profile = await createProfile(fixture, 'Personal', PERSONAL_HOME)
    const { runId } = await startSourceRun(fixture, profile.id)
    // Simulate "a previous instance owns the process": the run row carries a
    // pid + identity token, but stop() finds nothing in THIS registry.
    requireOk(
      fixture.runs.update(
        runId,
        { pid: 7777, pidIdentity: 'token-7777' },
        '2026-09-12T00:00:03.000Z',
      ),
    )
    fixture.processes.stopBehavior = { kind: 'not-found' }
    fixture.hostProcesses.identity.mockResolvedValue({ ok: true, data: 'token-7777' })

    const stopped = requireOk(
      await fixture.manager.failAndStop(runId, { kind: 'unknown', retryable: true }),
    )

    expect(fixture.hostProcesses.identity).toHaveBeenCalledWith(7777)
    expect(fixture.hostProcesses.terminate).toHaveBeenCalledWith(7777)
    expect(stopped.status).toBe('failed')
    expect(stopped.failureClassification).toEqual({ kind: 'unknown', retryable: true })
  })

  it('not found + identity mismatch → the pid belongs to someone else; treated as dead, never killed', async () => {
    const fixture = setup()
    const profile = await createProfile(fixture, 'Personal', PERSONAL_HOME)
    const { runId } = await startSourceRun(fixture, profile.id)
    requireOk(
      fixture.runs.update(
        runId,
        { pid: 7777, pidIdentity: 'token-7777' },
        '2026-09-12T00:00:03.000Z',
      ),
    )
    fixture.processes.stopBehavior = { kind: 'not-found' }
    fixture.hostProcesses.identity.mockResolvedValue({ ok: true, data: 'other-process' })

    const stopped = requireOk(
      await fixture.manager.failAndStop(runId, { kind: 'unknown', retryable: true }),
    )

    expect(fixture.hostProcesses.terminate).not.toHaveBeenCalled()
    expect(stopped.status).toBe('failed')
  })

  it('not found + survivor cannot be terminated → abort, run stays running', async () => {
    const fixture = setup()
    const profile = await createProfile(fixture, 'Personal', PERSONAL_HOME)
    const { runId } = await startSourceRun(fixture, profile.id)
    requireOk(
      fixture.runs.update(
        runId,
        { pid: 7777, pidIdentity: 'token-7777' },
        '2026-09-12T00:00:03.000Z',
      ),
    )
    fixture.processes.stopBehavior = { kind: 'not-found' }
    fixture.hostProcesses.identity.mockResolvedValue({ ok: true, data: 'token-7777' })
    fixture.hostProcesses.terminate.mockResolvedValue({
      ok: false,
      error: { code: 'UNKNOWN', message: 'taskkill failed.', retryable: true },
    })

    const result = await fixture.manager.failAndStop(runId, {
      kind: 'unknown',
      retryable: true,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CONFLICT')
    expect(runOf(fixture, runId).status).toBe('running')
  })

  it('a queued source settles failed + classification without any stop call', async () => {
    const fixture = setup({
      concurrency: { maxGlobalRuns: 1, maxRunsPerWorkspace: 5, maxRunsPerAgent: 5 },
    })
    const personal = await createProfile(fixture, 'Personal', PERSONAL_HOME)
    const first = await startSourceRun(fixture, personal.id)
    expect(runOf(fixture, first.runId).status).toBe('running')
    // The single global slot is taken, so this (worktree-less) run queues.
    const queued = requireOk(
      await fixture.manager.start({
        workspaceId: 'workspace-1',
        agentType: FAKE_AGENT.id,
        accountProfileId: personal.id,
      }),
    )
    expect(queued.status).toBe('queued')

    const stopped = requireOk(
      await fixture.manager.failAndStop(queued.id, { kind: 'unknown', retryable: true }),
    )

    expect(stopped.status).toBe('failed')
    expect(stopped.failureClassification).toEqual({ kind: 'unknown', retryable: true })
    expect(fixture.processes.stops).toHaveLength(0)
  })
})

describe('worktree reservation invariant (§19.3 step 3)', () => {
  it('refuses a second non-terminal run on the same worktree', async () => {
    const fixture = setup()
    const personal = await createProfile(fixture, 'Personal', PERSONAL_HOME)
    const work = await createProfile(fixture, 'Work', WORK_HOME)
    const first = await startSourceRun(fixture, personal.id)
    expect(runOf(fixture, first.runId).status).toBe('running')

    const second = await fixture.manager.start({
      workspaceId: 'workspace-1',
      agentType: FAKE_AGENT.id,
      accountProfileId: work.id,
      taskId: 'task-1',
      worktreeId: 'wt-1',
    })

    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error.code).toBe('VALIDATION_FAILED')
    expect(second.error.message).toContain(first.runId)
  })

  it('allows a run on the worktree once the previous run is terminal', async () => {
    const fixture = setup()
    const personal = await createProfile(fixture, 'Personal', PERSONAL_HOME)
    const work = await createProfile(fixture, 'Work', WORK_HOME)
    const first = await startSourceRun(fixture, personal.id)
    emitScenario(fixture, first.runId, loadScenario('rate-limit'))

    const second = requireOk(
      await fixture.manager.start({
        workspaceId: 'workspace-1',
        agentType: FAKE_AGENT.id,
        accountProfileId: work.id,
        taskId: 'task-1',
        worktreeId: 'wt-1',
      }),
    )
    expect(second.status).toBe('running')
  })
})

describe('continueWithProfile (§19.2/§19.3, §56.4)', () => {
  it('§56.4: rate-limited Run A → Continue with B — new run, same task + worktree, new profile, handoff carried, history kept', async () => {
    const fixture = setup()
    const personal = await createProfile(fixture, 'Personal', PERSONAL_HOME)
    const work = await createProfile(fixture, 'Work', WORK_HOME)
    const { runId: sourceId } = await startSourceRun(fixture, personal.id)
    emitScenario(fixture, sourceId, loadScenario('rate-limit'))
    const source = runOf(fixture, sourceId)
    expect(source.status).toBe('failed')
    expect(source.failureClassification?.kind).toBe('rate-limited')

    const target = requireOk(
      await fixture.manager.continueWithProfile({
        sourceRunId: sourceId,
        targetAgentId: FAKE_AGENT.id,
        targetAccountProfileId: work.id,
      }),
    )

    // New run, same task, same worktree, different account profile.
    expect(target.id).not.toBe(sourceId)
    expect(target.taskId).toBe('task-1')
    expect(target.worktreeId).toBe('wt-1')
    expect(target.accountProfileId).toBe(work.id)
    expect(target.status).toBe('running')
    // Handoff/Context inheritance: the prompt carries the continuation
    // context (original request + handoff summary from the source output).
    expect(target.prompt).toContain(`Continue Teskra Run ${sourceId}`)
    expect(target.prompt).toContain('rate-limit')
    expect(target.prompt).toContain('Original request:\nImplement TASK-218.')
    // History is preserved: the source run row is untouched.
    const sourceAfter = runOf(fixture, sourceId)
    expect(sourceAfter.status).toBe('failed')
    expect(sourceAfter.accountProfileId).toBe(personal.id)
    expect(sourceAfter.failureClassification?.kind).toBe('rate-limited')

    // §41 audit: continuation_created + account_switched, both linking the
    // source and target runs; profile_selected for the target run.
    const continuations = requireOk(fixture.accountEvents.listByType('agent.continuation_created'))
    expect(continuations).toHaveLength(1)
    expect(continuations[0]).toMatchObject({
      profileId: work.id,
      runId: target.id,
      payload: {
        taskId: 'task-1',
        sourceRunId: sourceId,
        targetRunId: target.id,
        reason: 'rate-limit',
        previousAgentId: FAKE_AGENT.id,
        previousAccountProfileId: personal.id,
        targetAccountProfileId: work.id,
      },
    })
    const switches = requireOk(fixture.accountEvents.listByType('agent.account_switched'))
    expect(switches).toHaveLength(1)
    expect(switches[0]).toMatchObject({
      profileId: work.id,
      runId: target.id,
      payload: {
        taskId: 'task-1',
        sourceRunId: sourceId,
        targetRunId: target.id,
        from: personal.id,
        to: work.id,
        reason: 'rate-limit',
      },
    })
    expect(
      requireOk(fixture.accountEvents.listByType('agent.profile_selected')).some(
        (event) => event.runId === target.id && event.profileId === work.id,
      ),
    ).toBe(true)
  })

  it('flow B: continuing a RUNNING source fails it first, then launches the target on the same worktree', async () => {
    const fixture = setup()
    const personal = await createProfile(fixture, 'Personal', PERSONAL_HOME)
    const work = await createProfile(fixture, 'Work', WORK_HOME)
    const { runId: sourceId } = await startSourceRun(fixture, personal.id)
    expect(runOf(fixture, sourceId).status).toBe('running')

    const target = requireOk(
      await fixture.manager.continueWithProfile({
        sourceRunId: sourceId,
        targetAgentId: FAKE_AGENT.id,
        targetAccountProfileId: work.id,
      }),
    )

    expect(fixture.processes.stops).toEqual([agentProcessId(sourceId)])
    const source = runOf(fixture, sourceId)
    expect(source.status).toBe('failed')
    expect(source.failureClassification).toBeDefined()
    expect(target.worktreeId).toBe('wt-1')
    expect(target.accountProfileId).toBe(work.id)
    expect(target.status).toBe('running')
  })

  it('flow A: a completed source continues without failAndStop (reason manual-switch, no rate-limit write)', async () => {
    const fixture = setup()
    const personal = await createProfile(fixture, 'Personal', PERSONAL_HOME)
    const work = await createProfile(fixture, 'Work', WORK_HOME)
    const { runId: sourceId } = await startSourceRun(fixture, personal.id)
    emitScenario(fixture, sourceId, loadScenario('success'))
    expect(runOf(fixture, sourceId).status).toBe('completed')

    const target = requireOk(
      await fixture.manager.continueWithProfile({
        sourceRunId: sourceId,
        targetAgentId: FAKE_AGENT.id,
        targetAccountProfileId: work.id,
      }),
    )

    expect(fixture.processes.stops).toHaveLength(0)
    expect(runOf(fixture, sourceId).status).toBe('completed')
    expect(target.status).toBe('running')
    const continuations = requireOk(fixture.accountEvents.listByType('agent.continuation_created'))
    expect(continuations[0]?.payload).toMatchObject({ reason: 'manual-switch' })
  })

  it('flow A aborts when the terminal source still has an unkillable survivor process', async () => {
    const fixture = setup()
    const personal = await createProfile(fixture, 'Personal', PERSONAL_HOME)
    const work = await createProfile(fixture, 'Work', WORK_HOME)
    const { runId: sourceId } = await startSourceRun(fixture, personal.id)
    emitScenario(fixture, sourceId, loadScenario('rate-limit'))
    requireOk(
      fixture.runs.update(
        sourceId,
        { pid: 8888, pidIdentity: 'token-8888' },
        '2026-09-12T00:00:03.000Z',
      ),
    )
    fixture.hostProcesses.identity.mockResolvedValue({ ok: true, data: 'token-8888' })
    fixture.hostProcesses.terminate.mockResolvedValue({
      ok: false,
      error: { code: 'UNKNOWN', message: 'taskkill failed.', retryable: true },
    })

    const result = await fixture.manager.continueWithProfile({
      sourceRunId: sourceId,
      targetAgentId: FAKE_AGENT.id,
      targetAccountProfileId: work.id,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CONFLICT')
    expect(requireOk(fixture.accountEvents.listByType('agent.continuation_created'))).toEqual([])
  })

  it('rejects a target profile belonging to another agent runtime via the §37 selector', async () => {
    const fixture = setup()
    const personal = await createProfile(fixture, 'Personal', PERSONAL_HOME)
    const { runId: sourceId } = await startSourceRun(fixture, personal.id)
    emitScenario(fixture, sourceId, loadScenario('rate-limit'))
    // A profile for a DIFFERENT runtime (windows vs wsl) — the selector must
    // reject it even though it belongs to the same agent.
    const windowsProfile = requireOk(
      await fixture.accountProfiles.create({
        agentId: FAKE_AGENT.id,
        name: 'Windows Profile',
        authType: 'external',
        runtime: { kind: 'windows' },
        configHome: 'C:\\Users\\u\\.fake',
      }),
    )

    const result = await fixture.manager.continueWithProfile({
      sourceRunId: sourceId,
      targetAgentId: FAKE_AGENT.id,
      targetAccountProfileId: windowsProfile.id,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('ACCOUNT_PROFILE_INCOMPATIBLE')
  })
})
