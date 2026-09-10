import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentDefinition, ProviderSessionRef, WorkbenchEvents } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import {
  createAgentEventRepository,
  createAgentRunRepository,
  createTaskRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createTeskraPaths } from '../paths'
import type { CodingAgentAdapter } from './adapters/coding-agent-adapter'
import { createAgentManager, type AgentManager } from './agent-manager'
import { createBuiltInAgentRegistry } from './agent-registry'
import { CLAUDE_AGENT } from './definitions/claude'
import { CODEX_AGENT } from './definitions/codex'

interface TestContext {
  readonly connection: Database.Database
  readonly events: EventBus<WorkbenchEvents>
  readonly manager: AgentManager
  readonly runs: ReturnType<typeof createAgentRunRepository>
  readonly agentEvents: ReturnType<typeof createAgentEventRepository>
  readonly adapters: Record<'codex' | 'claude', CodingAgentAdapter>
}

const contexts: TestContext[] = []
const homes: string[] = []

afterEach(() => {
  for (const context of contexts.splice(0)) {
    context.manager.dispose()
    context.connection.close()
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function mockAdapter(
  definition: AgentDefinition,
  providerSession?: ProviderSessionRef,
): CodingAgentAdapter {
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
    start: vi.fn(async (request) => ({
      ok: true as const,
      data: {
        runId: request.runId,
        processId: `${definition.id}:${request.runId}`,
        pid: definition.id === 'codex' ? 1001 : 1002,
        startedAt: '2026-09-10T00:00:01.000Z',
        ...(providerSession === undefined ? {} : { providerSession }),
      },
    })),
    send: vi.fn(async () => ({ ok: true as const, data: undefined })),
    cancel: vi.fn(async () => ({ ok: true as const, data: undefined })),
  }
}

function setup(): TestContext {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  const workspaces = createWorkspaceRepository(connection)
  const tasks = createTaskRepository(connection)
  const runs = createAgentRunRepository(connection)
  const agentEvents = createAgentEventRepository(connection)
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
  const claude = mockAdapter(CLAUDE_AGENT, {
    provider: 'claude',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
  })
  const home = mkdtempSync(join(tmpdir(), 'teskra-agent-manager-'))
  homes.push(home)
  let nextRun = 1
  const manager = createAgentManager({
    registry: registry.data,
    adapters: [codex, claude],
    runs,
    agentEvents,
    workspaces,
    tasks,
    worktrees,
    events,
    paths: createTeskraPaths({ TESKRA_HOME: home }),
    createRunId: () => `run-${String(nextRun++)}`,
    now: () => '2026-09-10T00:00:02.000Z',
  })
  const context = {
    connection,
    events,
    manager,
    runs,
    agentEvents,
    adapters: { codex, claude },
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
})
