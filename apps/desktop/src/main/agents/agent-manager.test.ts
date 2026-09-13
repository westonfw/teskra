import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentDefinition,
  ConcurrencyConfig,
  IpcResult,
  ProviderSessionRef,
  WorkbenchEvents,
} from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import {
  createAgentEventRepository,
  createAgentRunRepository,
  createCriteriaRepository,
  createHandoffRepository,
  createReviewRepository,
  createTaskRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createTeskraPaths, type TeskraPaths } from '../paths'
import type { HostProcessControl } from '../process/host-processes'
import {
  createCredentialStore,
  workspaceEnvCredentialKey,
  type CredentialCipher,
  type CredentialStore,
} from '../security/credential-store'
import type { CodingAgentAdapter } from './adapters/coding-agent-adapter'
import { createAgentManager, type AgentManager } from './agent-manager'
import { createBuiltInAgentRegistry } from './agent-registry'
import { createReviewCollector } from './review-collector'
import { CLAUDE_AGENT } from './definitions/claude'
import { CODEX_AGENT } from './definitions/codex'
import { createRunLogStore } from './run-log-store'

interface TestContext {
  readonly connection: Database.Database
  readonly events: EventBus<WorkbenchEvents>
  readonly manager: AgentManager
  readonly runs: ReturnType<typeof createAgentRunRepository>
  readonly agentEvents: ReturnType<typeof createAgentEventRepository>
  readonly handoffs: ReturnType<typeof createHandoffRepository>
  readonly reviews: ReturnType<typeof createReviewRepository>
  readonly workspaces: ReturnType<typeof createWorkspaceRepository>
  readonly worktrees: ReturnType<typeof createWorktreeRepository>
  readonly tasks: ReturnType<typeof createTaskRepository>
  readonly adapters: Record<'codex' | 'claude', CodingAgentAdapter>
  readonly paths: TeskraPaths
}

const contexts: TestContext[] = []
const homes: string[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.manager.dispose()
    context.connection.close()
  }
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

function mockAdapter(
  definition: AgentDefinition,
  providerSession?: ProviderSessionRef,
  supportsResume = false,
): CodingAgentAdapter {
  const handle = (request: { runId: string }) => ({
    ok: true as const,
    data: {
      runId: request.runId,
      processId: `${definition.id}:${request.runId}`,
      pid: definition.id === 'codex' ? 1001 : 1002,
      startedAt: '2026-09-10T00:00:01.000Z',
      ...(providerSession === undefined ? {} : { providerSession }),
    },
  })
  return {
    definition,
    detect: vi.fn(async ({ runtime }) => ({
      ok: true as const,
      data: {
        agentId: definition.id,
        runtime,
        installed: true,
        executable: definition.executable.command,
        version: 'test',
        overridden: false,
        fromCache: false,
        checkedAt: '2026-09-10T00:00:00.000Z',
      },
    })),
    start: vi.fn(async (request) => handle(request)),
    ...(supportsResume
      ? { resume: vi.fn(async (request: { runId: string }) => handle(request)) }
      : {}),
    send: vi.fn(async () => ({ ok: true as const, data: undefined })),
    cancel: vi.fn(async () => ({ ok: true as const, data: undefined })),
  }
}

function setup(
  concurrency?: ConcurrencyConfig,
  failAgentEventWrites = false,
  credentials?: CredentialStore,
  hostProcesses?: Pick<HostProcessControl, 'identity' | 'terminate'>,
): TestContext {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  const workspaces = createWorkspaceRepository(connection)
  const tasks = createTaskRepository(connection)
  const runs = createAgentRunRepository(connection)
  const agentEvents = createAgentEventRepository(connection)
  const handoffs = createHandoffRepository(connection)
  const reviews = createReviewRepository(connection)
  const worktrees = createWorktreeRepository(connection)
  const workspace = workspaces.create(
    {
      id: 'workspace-1',
      name: 'Demo',
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      path: '/repo',
    },
    '2026-09-10T00:00:00.000Z',
  )
  if (!workspace.ok) throw new Error(workspace.error.message)
  const registry = createBuiltInAgentRegistry()
  if (!registry.ok) throw new Error(registry.error.message)
  const events = createEventBus<WorkbenchEvents>()
  const codex = mockAdapter(CODEX_AGENT)
  const claude = mockAdapter(
    CLAUDE_AGENT,
    {
      provider: 'claude',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
    },
    true,
  )
  const home = mkdtempSync(join(tmpdir(), 'teskra-agent-manager-'))
  homes.push(home)
  let nextRun = 1
  const paths = createTeskraPaths({ TESKRA_HOME: home })
  const persistedEvents = failAgentEventWrites
    ? {
        ...agentEvents,
        append: () => ({
          ok: false as const,
          error: {
            code: 'UNKNOWN' as const,
            message: 'SQLite unavailable.',
            retryable: true,
          },
        }),
      }
    : agentEvents
  const manager = createAgentManager({
    registry: registry.data,
    adapters: [codex, claude],
    runs,
    agentEvents: persistedEvents,
    handoffs,
    reviewCollector: createReviewCollector({
      reviews,
      runs,
      criteria: createCriteriaRepository(connection),
    }),
    workspaces,
    tasks,
    worktrees,
    events,
    paths,
    runLogs: createRunLogStore({ paths }),
    createRunId: () => `run-${String(nextRun++)}`,
    now: () => '2026-09-10T00:00:02.000Z',
    ...(credentials === undefined ? {} : { credentials }),
    ...(hostProcesses === undefined ? {} : { hostProcesses }),
    ...(concurrency === undefined
      ? {}
      : { resolveConcurrency: () => ({ ok: true as const, data: concurrency }) }),
  })
  const context = {
    connection,
    events,
    manager,
    runs,
    agentEvents,
    handoffs,
    reviews,
    workspaces,
    worktrees,
    tasks,
    adapters: { codex, claude },
    paths,
  }
  contexts.push(context)
  return context
}

describe('AgentManager (TASK-028)', () => {
  it('runs Codex and Claude concurrently with independent persisted state', async () => {
    const context = setup()
    const codex = await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      prompt: 'Implement',
    })
    const claude = await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'claude',
      prompt: 'Review',
      approvalMode: 'read-only',
    })

    expect(codex).toMatchObject({
      ok: true,
      data: { id: 'run-1', status: 'running', executionMode: 'attended' },
    })
    expect(claude).toMatchObject({
      ok: true,
      data: {
        id: 'run-2',
        status: 'running',
        executionMode: 'attended',
        providerSession: { provider: 'claude' },
      },
    })
    expect(context.manager.list({ activeOnly: true })).toMatchObject({
      ok: true,
      data: [{ id: 'run-1' }, { id: 'run-2' }],
    })

    context.events.emit('process.exited', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      exitCode: 0,
    })
    expect(context.manager.get('run-1')).toMatchObject({
      ok: true,
      data: { status: 'completed', exitCode: 0 },
    })
    expect(context.manager.get('run-2')).toMatchObject({
      ok: true,
      data: { status: 'running' },
    })
  })

  it('records the host process identity token at launch for survivor verification', async () => {
    const identity = vi.fn(async (): Promise<IpcResult<string | null>> => ({
      ok: true,
      data: 'start-token-1001',
    }))
    const context = setup(undefined, false, undefined, {
      identity,
      terminate: vi.fn(async () => ({ ok: true as const, data: undefined })),
    })
    const started = await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      prompt: 'Implement',
    })

    expect(started).toMatchObject({
      ok: true,
      data: { pid: 1001, pidIdentity: 'start-token-1001' },
    })
    expect(identity).toHaveBeenCalledWith(1001)
    expect(context.runs.getById('run-1')).toMatchObject({
      ok: true,
      data: { pidIdentity: 'start-token-1001' },
    })
  })

  it('launches without an identity token when the capture fails', async () => {
    const identity = vi.fn(async (): Promise<IpcResult<string | null>> => ({
      ok: false,
      error: { code: 'UNKNOWN', message: 'stat failed', retryable: true },
    }))
    const context = setup(undefined, false, undefined, {
      identity,
      terminate: vi.fn(async () => ({ ok: true as const, data: undefined })),
    })
    const started = await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      prompt: 'Implement',
    })

    expect(started).toMatchObject({
      ok: true,
      data: { status: 'running', pid: 1001 },
    })
    expect(started.ok ? started.data.pidIdentity : 'unexpected').toBeUndefined()
  })

  it('does not resurrect a run that settled during the identity await', async () => {
    let releaseIdentity!: (value: IpcResult<string | null>) => void
    const identity = vi.fn(
      () =>
        new Promise<IpcResult<string | null>>((resolve) => {
          releaseIdentity = resolve
        }),
    )
    const context = setup(undefined, false, undefined, {
      identity,
      terminate: vi.fn(async () => ({ ok: true as const, data: undefined })),
    })
    const started = context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      prompt: 'Implement',
    })
    await vi.waitFor(() => expect(identity).toHaveBeenCalledWith(1001))

    // The process exits while launch() is parked in identity(): the
    // process.exited path writes the terminal status first.
    context.events.emit('process.exited', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      exitCode: 1,
    })
    releaseIdentity({ ok: true, data: 'start-token-1001' })

    // launch() must not write 'running' over the terminal state.
    expect(await started).toMatchObject({ ok: true, data: { status: 'failed', exitCode: 1 } })
    expect(context.manager.get('run-1')).toMatchObject({
      ok: true,
      data: { status: 'failed' },
    })
  })

  it('rejects orchestrated execution without a worktree before creating a run', async () => {
    const context = setup()
    const result = await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionMode: 'orchestrated',
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(context.runs.listActive()).toEqual({ ok: true, data: [] })
    expect(context.adapters.codex.start).not.toHaveBeenCalled()
  })

  it('dispose cancels every active run instead of leaking its process (P0-2)', async () => {
    const context = setup()
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'claude',
      approvalMode: 'read-only',
    })

    await context.manager.dispose()

    expect(context.adapters.codex.cancel).toHaveBeenCalledWith('run-1')
    expect(context.adapters.claude.cancel).toHaveBeenCalledWith('run-2')
    expect(context.manager.get('run-1')).toMatchObject({ ok: true, data: { status: 'cancelled' } })
    expect(context.manager.get('run-2')).toMatchObject({ ok: true, data: { status: 'cancelled' } })
    // A second dispose is a harmless no-op: nothing is cancelled twice.
    await context.manager.dispose()
    expect(context.adapters.codex.cancel).toHaveBeenCalledOnce()
  })

  it('flushes output the shutdown cancels produce before closing the run logs', async () => {
    const context = setup()
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    context.adapters.codex.cancel = vi.fn(async () => {
      // A dying Agent still writes: this chunk lands in the 32ms batcher
      // mid-dispose and must survive into the durable log.
      context.events.emit('process.output', {
        processId: 'codex:run-1',
        agentRunId: 'run-1',
        data: 'dying words',
      })
      return { ok: true as const, data: undefined }
    })

    await context.manager.dispose()

    const output = context.manager.getOutput('run-1')
    expect(output.ok && output.data.includes('dying words')).toBe(true)
  })

  it('dispose waits out an in-flight adapterless cancel before closing', async () => {
    let releaseIdentity!: (value: IpcResult<string | null>) => void
    const identity = vi.fn(
      () =>
        new Promise<IpcResult<string | null>>((resolve) => {
          releaseIdentity = resolve
        }),
    )
    const terminate = vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined }))
    const context = setup(undefined, false, undefined, { identity, terminate })
    const runDir = context.paths.runDir('run-1')
    if (!runDir.ok) throw new Error(runDir.error.message)
    const created = context.runs.create({
      id: 'run-1',
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: runDir.data,
      status: 'running',
    })
    if (!created.ok) throw new Error(created.error.message)
    const withPid = context.runs.update('run-1', { pid: 4242, pidIdentity: 'start-token-A' })
    if (!withPid.ok) throw new Error(withPid.error.message)

    const cancelling = context.manager.cancel('run-1')
    await vi.waitFor(() => expect(identity).toHaveBeenCalledWith(4242))

    // dispose() must not run off to runLogs.disposeAll()/DB close while the
    // settle is still parked in the identity probe.
    let disposed = false
    const disposing = context.manager.dispose().then(() => {
      disposed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(disposed).toBe(false)

    releaseIdentity({ ok: true, data: 'start-token-A' })
    await disposing
    await cancelling
    expect(disposed).toBe(true)
    expect(context.manager.get('run-1')).toMatchObject({
      ok: true,
      data: { status: 'cancelled' },
    })
  })

  it('translates output/input events and saves a non-zero crash exit', async () => {
    const context = setup()
    const output = vi.fn()
    const failed = vi.fn()
    context.events.subscribe('agent.output', output)
    context.events.subscribe('agent.failed', failed)
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })

    context.events.emit('process.output', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      data: 'working\r\n',
    })
    expect(await context.manager.send({ runId: 'run-1', data: 'continue\r' })).toEqual({
      ok: true,
      data: undefined,
    })
    context.events.emit('process.exited', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      exitCode: 7,
      signal: 15,
    })

    expect(output).toHaveBeenCalledWith({ runId: 'run-1', data: 'working\r\n' })
    expect(failed).toHaveBeenCalledWith({
      runId: 'run-1',
      error: expect.objectContaining({ code: 'UNKNOWN' }),
    })
    expect(context.manager.get('run-1')).toMatchObject({
      ok: true,
      data: {
        status: 'failed',
        exitCode: 7,
        lastOutputAt: '2026-09-10T00:00:02.000Z',
        lastInputAt: '2026-09-10T00:00:02.000Z',
      },
    })
    const history = context.agentEvents.listByRun('run-1')
    expect(history.ok && history.data.map((event) => event.eventType)).toEqual([
      'agent.created',
      'agent.started',
      'agent.output',
      'agent.input',
      'agent.failed',
    ])
    const files = context.paths.runFiles('run-1')
    if (!files.ok) throw new Error(files.error.message)
    const durableSeq = readFileSync(files.data.events, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => (JSON.parse(line) as { seq: number }).seq)
    expect(history.ok && history.data.map(({ seq }) => seq)).toEqual(durableSeq)
  })

  it('persists character-level PTY bursts as one output batch before exit', async () => {
    const context = setup()
    const output = vi.fn()
    context.events.subscribe('agent.output', output)
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })

    for (const data of ['a', 'b', 'c', '\r', '\n']) {
      context.events.emit('process.output', {
        processId: 'codex:run-1',
        agentRunId: 'run-1',
        data,
      })
    }
    expect(output).not.toHaveBeenCalled()
    context.events.emit('process.exited', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      exitCode: 0,
    })

    expect(output).toHaveBeenCalledOnce()
    expect(output).toHaveBeenCalledWith({ runId: 'run-1', data: 'abc\r\n' })
    const history = context.agentEvents.listByRun('run-1')
    expect(
      history.ok && history.data.filter(({ eventType }) => eventType === 'agent.output'),
    ).toHaveLength(1)
    expect(context.manager.getOutput('run-1')).toEqual({ ok: true, data: 'abc\r\n' })
  })

  it('persists command events and restores completed Run output after Manager restart', async () => {
    const context = setup()
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    context.events.emit('agent.command', { runId: 'run-1', command: 'npm test' })
    context.events.emit('process.output', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      data: 'all tests passed\r\n',
    })
    context.events.emit('process.exited', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      exitCode: 0,
    })
    await context.manager.dispose()

    const registry = createBuiltInAgentRegistry()
    if (!registry.ok) throw new Error(registry.error.message)
    const restarted = createAgentManager({
      registry: registry.data,
      adapters: [context.adapters.codex, context.adapters.claude],
      runs: context.runs,
      agentEvents: context.agentEvents,
      handoffs: context.handoffs,
      workspaces: context.workspaces,
      tasks: context.tasks,
      worktrees: context.worktrees,
      events: createEventBus(),
      paths: context.paths,
      runLogs: createRunLogStore({ paths: context.paths }),
    })

    expect(restarted.list({ workspaceId: 'workspace-1' })).toMatchObject({
      ok: true,
      data: [{ id: 'run-1', status: 'completed' }],
    })
    expect(restarted.getOutput('run-1')).toEqual({ ok: true, data: 'all tests passed\r\n' })
    const history = context.agentEvents.listByRun('run-1')
    expect(history.ok && history.data.map(({ eventType }) => eventType)).toEqual([
      'agent.created',
      'agent.started',
      'agent.command',
      'agent.output',
      'agent.completed',
    ])
    await restarted.dispose()
  })

  it('serves getOutput tails from the terminal log without rebuilding from SQLite', async () => {
    const context = setup()
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    for (const data of ['aaaa', 'bbbb']) {
      context.events.emit('process.output', {
        processId: 'codex:run-1',
        agentRunId: 'run-1',
        data,
      })
    }
    context.events.emit('process.exited', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      exitCode: 0,
    })

    expect(context.manager.getOutput('run-1')).toEqual({ ok: true, data: 'aaaabbbb' })
    expect(context.manager.getOutput('run-1', { tailBytes: 4 })).toEqual({
      ok: true,
      data: 'bbbb',
    })
  })

  it('rewrites run.json at lifecycle transitions but not per output batch', async () => {
    const context = setup()
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    const files = context.paths.runFiles('run-1')
    if (!files.ok) throw new Error(files.error.message)
    const launchedManifest = readFileSync(files.data.manifest, 'utf8')

    context.events.emit('process.output', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      data: 'chunk',
    })
    // Flushing the batcher performs the SQLite lastOutputAt update...
    expect(context.manager.getOutput('run-1')).toEqual({ ok: true, data: 'chunk' })
    const run = context.runs.getById('run-1')
    expect(run.ok && run.data?.lastOutputAt).toBe('2026-09-10T00:00:02.000Z')
    // ...but the manifest keeps its launch-time content until a transition.
    expect(readFileSync(files.data.manifest, 'utf8')).toBe(launchedManifest)

    context.events.emit('process.exited', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      exitCode: 0,
    })
    expect(readFileSync(files.data.manifest, 'utf8')).not.toBe(launchedManifest)
  })

  it('keeps the raw JSONL and terminal log when SQLite event writes fail', async () => {
    const context = setup(undefined, true)
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    context.events.emit('process.output', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      data: 'durable output\r\n',
    })
    context.events.emit('process.exited', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      exitCode: 0,
    })

    const files = context.paths.runFiles('run-1')
    if (!files.ok) throw new Error(files.error.message)
    expect(readFileSync(files.data.terminal, 'utf8')).toBe('durable output\r\n')
    const durableEvents = readFileSync(files.data.events, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { seq: number; eventType: string })
    expect(durableEvents.map(({ seq }) => seq)).toEqual([1, 2, 3, 4])
    expect(durableEvents.map(({ eventType }) => eventType)).toEqual([
      'agent.created',
      'agent.started',
      'agent.output',
      'agent.completed',
    ])
    expect(context.agentEvents.listByRun('run-1')).toEqual({ ok: true, data: [] })
    expect(JSON.parse(readFileSync(files.data.manifest, 'utf8'))).toMatchObject({
      id: 'run-1',
      status: 'completed',
      exitCode: 0,
    })
  })

  it('links Task history and derives Task status across multiple Runs', async () => {
    const context = setup()
    const task = context.tasks.create({
      id: 'task-1',
      workspaceId: 'workspace-1',
      title: 'Implement and review',
      status: 'ready',
    })
    if (!task.ok) throw new Error(task.error.message)

    const first = await context.manager.start({
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      agentType: 'codex',
      approvalMode: 'read-only',
    })
    const second = await context.manager.start({
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      agentType: 'claude',
      approvalMode: 'read-only',
    })
    expect(first).toMatchObject({ ok: true, data: { taskId: 'task-1' } })
    expect(second).toMatchObject({ ok: true, data: { taskId: 'task-1' } })
    expect(context.tasks.getById('task-1')).toMatchObject({
      ok: true,
      data: { status: 'running' },
    })

    context.events.emit('process.exited', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      exitCode: 0,
    })
    expect(context.tasks.getById('task-1')).toMatchObject({
      ok: true,
      data: { status: 'running' },
    })
    context.events.emit('process.exited', {
      processId: 'claude:run-2',
      agentRunId: 'run-2',
      exitCode: 0,
    })

    expect(context.tasks.getById('task-1')).toMatchObject({
      ok: true,
      data: { status: 'needs_review' },
    })
    expect(context.manager.list({ taskId: 'task-1' })).toMatchObject({
      ok: true,
      data: [{ taskId: 'task-1' }, { taskId: 'task-1' }],
    })
  })

  it('marks a stopped process as cancelled instead of failed', async () => {
    const context = setup()
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'claude' })
    context.adapters.claude.cancel = vi.fn(async (runId) => {
      context.events.emit('process.exited', {
        processId: `claude:${runId}`,
        agentRunId: runId,
        exitCode: 130,
        signal: 2,
      })
      return { ok: true as const, data: undefined }
    })

    const result = await context.manager.cancel('run-1')
    expect(result).toMatchObject({
      ok: true,
      data: { status: 'cancelled', exitCode: 130 },
    })
    expect(context.manager.list({ activeOnly: true })).toEqual({ ok: true, data: [] })
  })

  it('cancels an active run this instance does not own instead of failing', async () => {
    const context = setup()
    // A run reconciliation deliberately left active (pid identity unreadable)
    // or whose survivor could not be terminated: no adapter binding exists in
    // this instance, and without this path the run is an un-killable zombie
    // holding a concurrency slot forever.
    const runDir = context.paths.runDir('run-1')
    if (!runDir.ok) throw new Error(runDir.error.message)
    const created = context.runs.create({
      id: 'run-1',
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: runDir.data,
      status: 'running',
    })
    if (!created.ok) throw new Error(created.error.message)

    const cancelled = vi.fn()
    context.events.subscribe('agent.cancelled', cancelled)
    const result = await context.manager.cancel('run-1')

    // 'cancelled' is terminal and non-resumable, so this releases the slot
    // without inviting the double-write reconciliation was avoiding.
    expect(result).toMatchObject({ ok: true, data: { status: 'cancelled' } })
    expect(cancelled).toHaveBeenCalledWith({ runId: 'run-1' })
    expect(context.manager.list({ activeOnly: true })).toEqual({ ok: true, data: [] })
  })

  it('best-effort terminates the verified previous-instance process before settling', async () => {
    const identity = vi.fn(async (): Promise<IpcResult<string | null>> => ({
      ok: true,
      data: 'start-token-A',
    }))
    const terminate = vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined }))
    const context = setup(undefined, false, undefined, { identity, terminate })
    const runDir = context.paths.runDir('run-1')
    if (!runDir.ok) throw new Error(runDir.error.message)
    const created = context.runs.create({
      id: 'run-1',
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: runDir.data,
      status: 'running',
    })
    if (!created.ok) throw new Error(created.error.message)
    const withPid = context.runs.update('run-1', { pid: 4242, pidIdentity: 'start-token-A' })
    if (!withPid.ok) throw new Error(withPid.error.message)

    const result = await context.manager.cancel('run-1')

    expect(identity).toHaveBeenCalledWith(4242)
    expect(terminate).toHaveBeenCalledWith(4242)
    expect(result).toMatchObject({ ok: true, data: { status: 'cancelled' } })
  })

  it('never terminates an unverified pid during the adapterless cancel', async () => {
    for (const identity of [
      // Read failure: nothing is known about the pid.
      vi.fn(async (): Promise<IpcResult<string | null>> => ({
        ok: false,
        error: { code: 'UNKNOWN' as const, message: 'stat failed', retryable: true },
      })),
      // The pid was reused by an unrelated process.
      vi.fn(async (): Promise<IpcResult<string | null>> => ({ ok: true, data: 'other-token' })),
    ]) {
      const terminate = vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined }))
      const context = setup(undefined, false, undefined, { identity, terminate })
      const runDir = context.paths.runDir('run-1')
      if (!runDir.ok) throw new Error(runDir.error.message)
      const created = context.runs.create({
        id: 'run-1',
        workspaceId: 'workspace-1',
        agentType: 'codex',
        executionMode: 'attended',
        runDir: runDir.data,
        status: 'running',
      })
      if (!created.ok) throw new Error(created.error.message)
      const withPid = context.runs.update('run-1', { pid: 4242, pidIdentity: 'start-token-A' })
      if (!withPid.ok) throw new Error(withPid.error.message)

      // The cancel still settles — the user's intent is honored — but nothing
      // is killed without a verified identity.
      const result = await context.manager.cancel('run-1')
      expect(terminate).not.toHaveBeenCalled()
      expect(result).toMatchObject({ ok: true, data: { status: 'cancelled' } })
      await context.manager.dispose()
    }
  })

  it('advances the queue after cancelling an adapterless active run', async () => {
    const context = setup({ maxGlobalRuns: 1, maxRunsPerWorkspace: 3, maxRunsPerAgent: 2 })
    // The zombie holding the only slot (no process in this instance, so no
    // process.exited will ever advance the queue for it). It gets a worktree
    // so the new run queues on the concurrency limit instead of tripping the
    // unisolated-write conflict.
    const worktree = context.worktrees.create({
      id: 'worktree-zombie',
      workspaceId: 'workspace-1',
      branch: 'agent/zombie',
      baseBranch: 'main',
      path: '/worktrees/zombie',
      state: 'ready',
      isolation: 'worktree',
    })
    if (!worktree.ok) throw new Error(worktree.error.message)
    const runDir = context.paths.runDir('run-zombie')
    if (!runDir.ok) throw new Error(runDir.error.message)
    const zombie = context.runs.create({
      id: 'run-zombie',
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionMode: 'orchestrated',
      worktreeId: 'worktree-zombie',
      runDir: runDir.data,
      status: 'running',
    })
    if (!zombie.ok) throw new Error(zombie.error.message)

    const queued = await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
    })
    expect(queued).toMatchObject({ ok: true, data: { status: 'queued' } })
    expect(context.adapters.codex.start).not.toHaveBeenCalled()

    await context.manager.cancel('run-zombie')

    // The cancel itself must kick the queue: nothing else ever will.
    await vi.waitFor(() => expect(context.adapters.codex.start).toHaveBeenCalled())
  })

  it('settles an adapterless run exactly once under concurrent cancels', async () => {
    const releases: Array<(value: IpcResult<string | null>) => void> = []
    const identity = vi.fn(
      () =>
        new Promise<IpcResult<string | null>>((resolve) => {
          releases.push(resolve)
        }),
    )
    const terminate = vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined }))
    const context = setup(undefined, false, undefined, { identity, terminate })
    const runDir = context.paths.runDir('run-1')
    if (!runDir.ok) throw new Error(runDir.error.message)
    const created = context.runs.create({
      id: 'run-1',
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: runDir.data,
      status: 'running',
    })
    if (!created.ok) throw new Error(created.error.message)
    const withPid = context.runs.update('run-1', { pid: 4242, pidIdentity: 'start-token-A' })
    if (!withPid.ok) throw new Error(withPid.error.message)

    const cancelled = vi.fn()
    context.events.subscribe('agent.cancelled', cancelled)

    // The first cancel claims the settle; the second awaits the SAME
    // execution — it never reaches its own identity read.
    const first = context.manager.cancel('run-1')
    const second = context.manager.cancel('run-1')
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    for (const release of releases) release({ ok: true, data: 'start-token-A' })

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toMatchObject({ ok: true, data: { status: 'cancelled' } })
    expect(secondResult).toMatchObject({ ok: true, data: { status: 'cancelled' } })
    // One execution total: one identity read, one verified terminate, one
    // settle (event, handoff collection, log close).
    expect(identity).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(cancelled).toHaveBeenCalledWith({ runId: 'run-1' })
  })

  it('cancel stops only the process — the worktree, branch and files are untouched (TASK-047)', async () => {
    const context = setup()
    const worktree = context.worktrees.create({
      id: 'worktree-1',
      workspaceId: 'workspace-1',
      branch: 'agent/run-1',
      baseBranch: 'main',
      path: '/worktrees/run-1',
      state: 'dirty',
      isolation: 'worktree',
    })
    if (!worktree.ok) throw new Error(worktree.error.message)
    await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      worktreeId: 'worktree-1',
    })

    const result = await context.manager.cancel('run-1')
    expect(result).toMatchObject({ ok: true, data: { status: 'cancelled' } })

    // The worktree record is byte-identical: no state transition, no
    // discarded/archived marker — cancel is process-scoped by design.
    expect(context.worktrees.getById('worktree-1')).toEqual(worktree)
  })

  it.each([
    ['global', { maxGlobalRuns: 1, maxRunsPerWorkspace: 3, maxRunsPerAgent: 2 }],
    ['workspace', { maxGlobalRuns: 4, maxRunsPerWorkspace: 1, maxRunsPerAgent: 2 }],
    ['agent', { maxGlobalRuns: 4, maxRunsPerWorkspace: 3, maxRunsPerAgent: 1 }],
  ] as const)('queues runs at the %s concurrency limit and advances FIFO', async (kind, policy) => {
    const context = setup(policy)
    if (kind === 'agent') {
      const secondWorkspace = context.workspaces.create({
        id: 'workspace-2',
        name: 'Second',
        runtime: { kind: 'wsl', distro: 'Ubuntu' },
        path: '/repo-2',
      })
      if (!secondWorkspace.ok) throw new Error(secondWorkspace.error.message)
    }
    const first = await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      approvalMode: 'read-only',
    })
    const secondAgent = kind === 'agent' ? 'codex' : 'claude'
    const second = await context.manager.start({
      workspaceId: kind === 'agent' ? 'workspace-2' : 'workspace-1',
      agentType: secondAgent,
      approvalMode: 'read-only',
    })
    expect(first).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(second).toMatchObject({ ok: true, data: { status: 'queued' } })

    context.events.emit('process.exited', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      exitCode: 0,
    })
    await vi.waitFor(() => {
      expect(context.manager.get('run-2')).toMatchObject({
        ok: true,
        data: { status: 'running' },
      })
    })
  })

  it('rejects a second direct writable run but permits read-only and isolated runs', async () => {
    const context = setup()
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })

    const conflicting = await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'claude',
    })
    expect(conflicting).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: expect.stringContaining('run-1') },
    })
    const readOnly = await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'claude',
      approvalMode: 'read-only',
    })
    expect(readOnly).toMatchObject({ ok: true, data: { status: 'running' } })

    const worktree = context.worktrees.create({
      id: 'worktree-1',
      workspaceId: 'workspace-1',
      branch: 'teskra/run-3',
      baseBranch: 'main',
      path: '/worktrees/run-3',
      state: 'ready',
      isolation: 'worktree',
    })
    if (!worktree.ok) throw new Error(worktree.error.message)
    const isolated = await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'claude',
      worktreeId: 'worktree-1',
    })
    expect(isolated).toMatchObject({ ok: true, data: { status: 'running' } })
  })

  it('cancels a queued run without disturbing FIFO progression', async () => {
    const context = setup({
      maxGlobalRuns: 1,
      maxRunsPerWorkspace: 3,
      maxRunsPerAgent: 2,
    })
    await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      approvalMode: 'read-only',
    })
    await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'claude',
      approvalMode: 'read-only',
    })
    await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      approvalMode: 'read-only',
    })

    expect(await context.manager.cancel('run-2')).toMatchObject({
      ok: true,
      data: { status: 'cancelled' },
    })
    expect(context.manager.get('run-3')).toMatchObject({
      ok: true,
      data: { status: 'queued' },
    })
    context.events.emit('process.exited', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      exitCode: 0,
    })
    await vi.waitFor(() => {
      expect(context.manager.get('run-3')).toMatchObject({
        ok: true,
        data: { status: 'running' },
      })
    })
  })

  it('clears active and queued capacity without deadlock when every run is cancelled', async () => {
    const context = setup({
      maxGlobalRuns: 1,
      maxRunsPerWorkspace: 3,
      maxRunsPerAgent: 2,
    })
    for (const agentType of ['codex', 'claude', 'codex'] as const) {
      await context.manager.start({
        workspaceId: 'workspace-1',
        agentType,
        approvalMode: 'read-only',
      })
    }

    await context.manager.cancel('run-2')
    await context.manager.cancel('run-3')
    await context.manager.cancel('run-1')
    await vi.waitFor(() => {
      expect(context.manager.list({ activeOnly: true })).toEqual({ ok: true, data: [] })
    })
  })
})

describe('AgentManager resume (TASK-042)', () => {
  const interrupt = (context: TestContext, runId: string) => {
    const updated = context.runs.update(
      runId,
      {
        status: 'interrupted',
        processId: null,
        pid: null,
        finishedAt: '2026-09-10T00:00:03.000Z',
        exitCode: 1,
        error: { message: 'process lost' },
      },
      '2026-09-10T00:00:03.000Z',
    )
    if (!updated.ok) throw new Error(updated.error.message)
  }

  it('rejects resuming a run that is not interrupted', async () => {
    const context = setup()
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })

    const resumed = await context.manager.resume({ runId: 'run-1' })

    expect(resumed).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Only interrupted Agent runs can be resumed.' },
    })
  })

  it('uses the provider native session when the agent supports resume', async () => {
    const context = setup()
    await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'claude',
      prompt: 'Review the diff',
    })
    interrupt(context, 'run-1')

    const resumed = await context.manager.resume({ runId: 'run-1' })

    expect(resumed).toMatchObject({
      ok: true,
      data: { id: 'run-1', status: 'running' },
    })
    if (resumed.ok) {
      expect(resumed.data.finishedAt ?? null).toBeNull()
      expect(resumed.data.exitCode ?? null).toBeNull()
      expect(resumed.data.error ?? null).toBeNull()
    }
    const claude = context.adapters.claude
    expect(claude.resume).toHaveBeenCalledOnce()
    expect(claude.resume).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        providerSession: {
          provider: 'claude',
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
        },
      }),
    )
    expect(claude.start).toHaveBeenCalledOnce()
    const history = context.agentEvents.listByRun('run-1')
    expect(history.ok && history.data.map(({ eventType }) => eventType)).toEqual([
      'agent.created',
      'agent.started',
      'agent.resume_requested',
      'agent.resumed',
    ])
    expect(
      history.ok && history.data.find(({ eventType }) => eventType === 'agent.resumed')?.payload,
    ).toMatchObject({ nativeSession: true })
  })

  it('rejects a concurrent second resume while the first is still detecting', async () => {
    const context = setup()
    const worktree = context.worktrees.create({
      id: 'worktree-1',
      workspaceId: 'workspace-1',
      branch: 'teskra/run-1',
      baseBranch: 'main',
      path: '/worktrees/run-1',
      state: 'ready',
      isolation: 'worktree',
    })
    if (!worktree.ok) throw new Error(worktree.error.message)
    await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'claude',
      executionMode: 'orchestrated',
      worktreeId: 'worktree-1',
    })
    interrupt(context, 'run-1')

    // Hold both resumes inside the async detection window: both callers read
    // status 'interrupted' before either one transitions the Run.
    let releaseDetect!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseDetect = resolve
    })
    const claude = context.adapters.claude
    vi.mocked(claude.detect).mockImplementation(async ({ runtime }) => {
      await gate
      return {
        ok: true as const,
        data: {
          agentId: 'claude',
          runtime,
          installed: true,
          executable: 'claude',
          version: 'test',
          overridden: false,
          fromCache: false,
          checkedAt: '2026-09-10T00:00:00.000Z',
        },
      }
    })

    const first = context.manager.resume({ runId: 'run-1' })
    const second = context.manager.resume({ runId: 'run-1' })
    releaseDetect()

    expect(await first).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(await second).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
    // Exactly one relaunch and one resume request — never two processes for
    // the same Run (the second ProcessManager.start would collide on the
    // process id and mark the running Run failed).
    expect(claude.resume).toHaveBeenCalledOnce()
    const history = context.agentEvents.listByRun('run-1')
    expect(
      history.ok && history.data.filter(({ eventType }) => eventType === 'agent.resume_requested'),
    ).toHaveLength(1)
    expect(
      history.ok && history.data.filter(({ eventType }) => eventType === 'agent.resumed'),
    ).toHaveLength(1)
  })

  it('relaunches with the persisted mode: exec headless, legacy interactive (ADR-0007)', async () => {
    const context = setup()
    const started = await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      mode: 'exec',
      prompt: 'workflow step',
    })
    expect(started.ok).toBe(true)
    // The launch mode is persisted on the run record at create time.
    if (started.ok) expect(started.data.mode).toBe('exec')
    interrupt(context, 'run-1')

    const resumed = await context.manager.resume({ runId: 'run-1' })
    expect(resumed.ok).toBe(true)
    // Codex resumes via a fresh adapter.start (no native provider session).
    expect(context.adapters.codex.start).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'exec' }),
    )

    // A run without a recorded mode (pre-009 legacy) keeps interactive resume.
    const legacyContext = setup()
    const legacy = await legacyContext.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
    })
    expect(legacy.ok).toBe(true)
    interrupt(legacyContext, 'run-1')
    const resumedLegacy = await legacyContext.manager.resume({ runId: 'run-1' })
    expect(resumedLegacy.ok).toBe(true)
    expect(legacyContext.adapters.codex.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'interactive' }),
    )
  })

  it('starts a new session with injected context when native resume is unavailable', async () => {
    const context = setup()
    await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      prompt: 'Implement the feature',
    })
    context.events.emit('process.output', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      data: 'half of the work is done\r\n',
    })
    const handoff = context.handoffs.save({
      id: 'handoff-1',
      runId: 'run-1',
      type: 'implementation',
      payload: { summary: 'finished the parser half' },
      parseStatus: 'degraded',
    })
    if (!handoff.ok) throw new Error(handoff.error.message)
    interrupt(context, 'run-1')

    const resumed = await context.manager.resume({ runId: 'run-1', prompt: 'Keep going' })

    expect(resumed).toMatchObject({ ok: true, data: { id: 'run-1', status: 'running' } })
    const codex = context.adapters.codex
    expect(codex.start).toHaveBeenCalledTimes(2)
    const relaunched = vi.mocked(codex.start).mock.calls[1]?.[0]
    expect(relaunched?.prompt).toContain('Resume interrupted Teskra Run run-1')
    expect(relaunched?.prompt).toContain('Original request:\nImplement the feature')
    expect(relaunched?.prompt).toContain('Handoff summary:\nfinished the parser half')
    expect(relaunched?.prompt).toContain('half of the work is done')
    expect(relaunched?.prompt).toContain('Additional instructions:\nKeep going')
    const history = context.agentEvents.listByRun('run-1')
    expect(
      history.ok && history.data.find(({ eventType }) => eventType === 'agent.resumed')?.payload,
    ).toMatchObject({ nativeSession: false })
  })

  it('builds the resume context from a bounded terminal log tail (P1-6)', async () => {
    const context = setup()
    await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'codex',
      prompt: 'Implement the feature',
    })
    context.events.emit('process.output', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      data: `${'y'.repeat(30_000)}TAIL-MARKER`,
    })
    interrupt(context, 'run-1')

    const resumed = await context.manager.resume({ runId: 'run-1' })

    expect(resumed).toMatchObject({ ok: true, data: { id: 'run-1', status: 'running' } })
    const relaunched = vi.mocked(context.adapters.codex.start).mock.calls[1]?.[0]
    // The context keeps the recent tail, not the run's entire 30KB output.
    expect(relaunched?.prompt).toContain('TAIL-MARKER')
    expect(relaunched?.prompt?.length ?? Number.MAX_SAFE_INTEGER).toBeLessThan(20_000)
  })
})

describe('AgentManager handoff collection (TASK-051, ADR-0004)', () => {
  const exitRun = (context: TestContext, runId: string, exitCode = 0) => {
    context.events.emit('process.exited', {
      processId: `codex:${runId}`,
      agentRunId: runId,
      exitCode,
    })
  }

  it('collects a valid handoff file as parse_status ok when the run completes', async () => {
    const context = setup()
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    const files = context.paths.runFiles('run-1')
    if (!files.ok) throw new Error(files.error.message)
    writeFileSync(
      files.data.handoff,
      JSON.stringify({
        runId: 'run-1',
        type: 'implementation',
        summary: 'Codex finished the work.',
        filesChanged: ['src/index.ts'],
      }),
      'utf8',
    )

    exitRun(context, 'run-1')

    expect(context.manager.get('run-1')).toMatchObject({
      ok: true,
      data: { status: 'completed', exitCode: 0 },
    })
    expect(context.handoffs.getByRunId('run-1')).toMatchObject({
      ok: true,
      data: {
        runId: 'run-1',
        type: 'implementation',
        parseStatus: 'ok',
        rawPath: files.data.handoff,
        payload: { summary: 'Codex finished the work.' },
      },
    })
  })

  it('persists review findings from a completed run handoff (TASK-053)', async () => {
    const context = setup()
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    const files = context.paths.runFiles('run-1')
    if (!files.ok) throw new Error(files.error.message)
    writeFileSync(
      files.data.handoff,
      JSON.stringify({
        runId: 'run-1',
        type: 'review',
        summary: 'Reviewed the change.',
        findings: [
          {
            severity: 'high',
            title: 'Missing null check',
            file: 'src/api.ts',
            line: 12,
            evidence: ['src/api.ts:12 dereferences user.name'],
          },
        ],
      }),
      'utf8',
    )

    exitRun(context, 'run-1')

    expect(context.manager.get('run-1')).toMatchObject({
      ok: true,
      data: { status: 'completed' },
    })
    expect(context.reviews.listFindingsByRun('run-1')).toMatchObject({
      ok: true,
      data: [
        {
          runId: 'run-1',
          severity: 'high',
          title: 'Missing null check',
          file: 'src/api.ts',
          line: 12,
        },
      ],
    })
  })

  it('degrades a malformed handoff, keeps the raw file, and still completes the run', async () => {
    const context = setup()
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    const files = context.paths.runFiles('run-1')
    if (!files.ok) throw new Error(files.error.message)
    writeFileSync(files.data.handoff, '{ definitely-not-valid-json', 'utf8')

    exitRun(context, 'run-1')

    expect(context.manager.get('run-1')).toMatchObject({
      ok: true,
      data: { status: 'completed' },
    })
    expect(context.handoffs.getByRunId('run-1')).toMatchObject({
      ok: true,
      data: { parseStatus: 'degraded', rawPath: files.data.handoff },
    })
    expect(readFileSync(files.data.handoff, 'utf8')).toBe('{ definitely-not-valid-json')
  })

  it('falls back to the terminal log summary when the agent writes no handoff', async () => {
    const context = setup()
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    context.events.emit('process.output', {
      processId: 'codex:run-1',
      agentRunId: 'run-1',
      data: 'work done without a handoff\r\n',
    })

    exitRun(context, 'run-1')

    expect(context.manager.get('run-1')).toMatchObject({
      ok: true,
      data: { status: 'completed' },
    })
    expect(context.handoffs.getByRunId('run-1')).toMatchObject({
      ok: true,
      data: {
        parseStatus: 'missing',
        payload: {
          source: 'terminal.log',
          summary: 'work done without a handoff',
        },
      },
    })
  })

  it('collects the handoff even when the run failed', async () => {
    const context = setup()
    await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    const files = context.paths.runFiles('run-1')
    if (!files.ok) throw new Error(files.error.message)
    writeFileSync(
      files.data.handoff,
      JSON.stringify({ runId: 'run-1', type: 'blocker', summary: 'Blocked on credentials.' }),
      'utf8',
    )

    exitRun(context, 'run-1', 1)

    expect(context.manager.get('run-1')).toMatchObject({
      ok: true,
      data: { status: 'failed', exitCode: 1 },
    })
    expect(context.handoffs.getByRunId('run-1')).toMatchObject({
      ok: true,
      data: { parseStatus: 'ok', type: 'blocker' },
    })
  })

  it('never blocks run completion even if handoff collection throws', async () => {
    const context = setup()
    await context.manager.dispose()
    const registry = createBuiltInAgentRegistry()
    if (!registry.ok) throw new Error(registry.error.message)
    const manager = createAgentManager({
      registry: registry.data,
      adapters: [context.adapters.codex, context.adapters.claude],
      runs: context.runs,
      agentEvents: context.agentEvents,
      handoffs: context.handoffs,
      workspaces: context.workspaces,
      tasks: context.tasks,
      worktrees: context.worktrees,
      events: context.events,
      paths: context.paths,
      runLogs: createRunLogStore({ paths: context.paths }),
      handoffCollector: {
        collect: () => {
          throw new Error('collector exploded')
        },
      },
    })
    contexts.push({ ...context, manager })

    const started = await manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    if (!started.ok) throw new Error(started.error.message)
    context.events.emit('process.exited', {
      processId: `codex:${started.data.id}`,
      agentRunId: started.data.id,
      exitCode: 0,
    })

    expect(manager.get(started.data.id)).toMatchObject({
      ok: true,
      data: { status: 'completed', exitCode: 0 },
    })
  })
})

describe('AgentManager permission projection (TASK-077)', () => {
  it('projects the approval mode into CLI-side config before launching Claude', async () => {
    const context = setup()
    const started = await context.manager.start({
      workspaceId: 'workspace-1',
      agentType: 'claude',
      approvalMode: 'read-only',
    })
    if (!started.ok) throw new Error(started.error.message)

    const request = vi.mocked(context.adapters.claude.start).mock.calls[0]?.[0]
    expect(request?.permissionProfile).toEqual({
      id: 'claude:read-only',
      approvalMode: 'read-only',
      allow: [],
      deny: [],
    })
    const files = context.paths.runFiles('run-1')
    if (!files.ok) throw new Error(files.error.message)
    const expectedPath = join(files.data.directory, 'permission-settings.json')
    expect(request?.permissionConfigPath).toBe(expectedPath)
    expect(JSON.parse(readFileSync(expectedPath, 'utf8'))).toEqual({
      permissions: {
        // 'default', not 'plan': plan mode would also block the handoff write.
        defaultMode: 'default',
        allow: [`Edit(${files.data.directory.replaceAll('\\', '/')}/**)`],
      },
    })
  })

  it('projects an args-only profile for Codex without writing any config file', async () => {
    const context = setup()
    const started = await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    if (!started.ok) throw new Error(started.error.message)

    const request = vi.mocked(context.adapters.codex.start).mock.calls[0]?.[0]
    expect(request?.permissionProfile).toEqual({
      id: 'codex:safe-auto',
      approvalMode: 'safe-auto',
      allow: [],
      deny: [],
    })
    expect(request?.permissionConfigPath).toBeUndefined()
    const files = context.paths.runFiles('run-1')
    if (!files.ok) throw new Error(files.error.message)
    expect(existsSync(join(files.data.directory, 'permission-settings.json'))).toBe(false)
  })
})

/** Deterministic stand-in for safeStorage: reversibly "encrypts" via base64. */
function mockCipher(available = true): CredentialCipher {
  return {
    isAvailable: () => available,
    encrypt: (plaintext) => `enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
    decrypt: (ciphertext) =>
      Buffer.from(ciphertext.slice('enc:'.length), 'base64').toString('utf8'),
  }
}

describe('AgentManager workspace env secrets (TASK-088)', () => {
  const SECRET = 'sk-live-secret-value'

  function setupWithSecrets(cipherAvailable = true): {
    context: TestContext
    store: CredentialStore
    ref: string
    credentialPath: string
  } {
    const home = mkdtempSync(join(tmpdir(), 'teskra-agent-secrets-'))
    homes.push(home)
    const credentialPath = createTeskraPaths({ TESKRA_HOME: home }).credentials()
    const store = createCredentialStore({
      paths: createTeskraPaths({ TESKRA_HOME: home }),
      cipher: mockCipher(cipherAvailable),
    })
    const context = setup(undefined, false, store)
    const ref = workspaceEnvCredentialKey('workspace-1', 'OPENAI_API_KEY')
    if (cipherAvailable) {
      expect(store.set(ref, SECRET).ok).toBe(true)
    }
    const updated = context.workspaces.update('workspace-1', {
      env: { PLAIN_VAR: 'visible', OPENAI_API_KEY: { secretRef: ref } },
    })
    if (!updated.ok) throw new Error(updated.error.message)
    return { context, store, ref, credentialPath }
  }

  it('resolves secret refs into the process environment only — never into the Run directory', async () => {
    const { context, ref, credentialPath } = setupWithSecrets()
    const started = await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    if (!started.ok) throw new Error(started.error.message)

    // The launched process receives the decrypted value.
    const request = vi.mocked(context.adapters.codex.start).mock.calls[0]?.[0]
    expect(request?.workspace.env).toEqual({ PLAIN_VAR: 'visible', OPENAI_API_KEY: SECRET })

    // Acceptance: the secret appears neither in env_json nor in any Run file.
    const persisted = context.workspaces.getById('workspace-1')
    expect(persisted.ok && persisted.data?.env).toEqual({
      PLAIN_VAR: 'visible',
      OPENAI_API_KEY: { secretRef: ref },
    })
    const files = context.paths.runFiles('run-1')
    if (!files.ok) throw new Error(files.error.message)
    for (const file of [files.data.manifest, files.data.events, files.data.terminal]) {
      expect(readFileSync(file, 'utf8')).not.toContain(SECRET)
    }
    // The credential file itself holds ciphertext only.
    expect(readFileSync(credentialPath, 'utf8')).not.toContain(SECRET)
  })

  it('fails the Run explicitly when the referenced credential is missing', async () => {
    const { context, store } = setupWithSecrets()
    expect(store.delete(workspaceEnvCredentialKey('workspace-1', 'OPENAI_API_KEY')).ok).toBe(true)
    const started = await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    expect(started.ok).toBe(false)
    if (!started.ok) expect(started.error.code).toBe('VALIDATION_FAILED')
    expect(vi.mocked(context.adapters.codex.start).mock.calls).toEqual([])
  })

  it('fails the Run explicitly when the cipher is unavailable', async () => {
    const { context } = setupWithSecrets(false)
    const started = await context.manager.start({ workspaceId: 'workspace-1', agentType: 'codex' })
    expect(started.ok).toBe(false)
    if (!started.ok) expect(started.error.code).toBe('CAPABILITY_NOT_AVAILABLE')
    expect(vi.mocked(context.adapters.codex.start).mock.calls).toEqual([])
  })
})
