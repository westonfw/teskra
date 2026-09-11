import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IpcResult, WorkbenchEvents } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import {
  createAgentEventRepository,
  createAgentRunRepository,
  createCriteriaRepository,
  createHandoffRepository,
  createTaskRepository,
  createWorkflowRunRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createWorktreeManager } from '../git/worktree-manager'
import { createTeskraPaths } from '../paths'
import { createCommandRunner, type CommandRunner } from '../process/command-runner'
import { createPromptTemplateService } from '../prompts/prompt-template-service'
import { createWorkspaceRuntime } from '../workspace/runtime'
import type { CodingAgentAdapter } from '../agents/adapters/coding-agent-adapter'
import { createAgentManager } from '../agents/agent-manager'
import { createDefaultAgentRegistry } from '../agents/agent-registry'
import { CODEX_AGENT } from '../agents/definitions/codex'
import { FAKE_AGENT } from '../agents/definitions/fake'
import { createRunLogStore } from '../agents/run-log-store'
import { createDispatchService, type DispatchService } from './dispatch-service'
import { createWorkflowEngine } from './workflow-engine'
import { createWorkflowRunStore } from './workflow-run-store'

/**
 * TASK-059 acceptance: dispatch can select the agent, can select the worktree
 * isolation tier, and produces a queryable handoff once the run completes —
 * plus the ADR-0002 red line that orchestrated runs are never launched
 * without a worktree. Real git repository + in-memory SQLite; the agent
 * adapters are mocked (agent-manager.test.ts pattern).
 */

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function mockAdapter(definition: typeof CODEX_AGENT | typeof FAKE_AGENT): CodingAgentAdapter {
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
    start: vi.fn(async (request: { runId: string }) => ({
      ok: true as const,
      data: {
        runId: request.runId,
        processId: `${definition.id}:${request.runId}`,
        pid: 4242,
        startedAt: '2026-09-10T00:00:01.000Z',
      },
    })),
    send: vi.fn(async () => ({ ok: true as const, data: undefined })),
    cancel: vi.fn(async () => ({ ok: true as const, data: undefined })),
  }
}

interface Fixture {
  readonly service: DispatchService
  readonly events: EventBus<WorkbenchEvents>
  readonly commands: CommandRunner
  readonly adapters: { readonly codex: CodingAgentAdapter; readonly fake: CodingAgentAdapter }
  readonly agents: ReturnType<typeof createAgentManager>
  readonly worktrees: ReturnType<typeof createWorktreeRepository>
  readonly handoffs: ReturnType<typeof createHandoffRepository>
  readonly workflowRuns: ReturnType<typeof createWorkflowRunRepository>
  readonly paths: ReturnType<typeof createTeskraPaths>
  readonly repoDir: string
}

async function setup(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-dispatch-'))
  directories.push(directory)
  const repoDir = join(directory, 'repo')
  const dataRoot = join(directory, 'data-root')
  mkdirSync(repoDir)
  const commands = createCommandRunner({ hostPlatform: 'linux' })
  const git = async (...args: string[]) => {
    const result = await commands.run({ command: 'git', args, cwd: repoDir, timeoutMs: 15_000 })
    if (!result.ok || result.data.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.ok ? result.data.stderr : 'ipc'}`)
    }
  }
  await git('init', '--initial-branch=main')
  await git('config', 'user.name', 'Teskra Test')
  await git('config', 'user.email', 'teskra@example.invalid')
  writeFileSync(join(repoDir, 'README.md'), 'fixture\n')
  await git('add', '--all')
  await git('commit', '--message', 'feat: initial')

  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(database)
  if (!migrated.ok) throw new Error(migrated.error.message)
  databases.push(database)
  const workspaces = createWorkspaceRepository(database)
  const worktrees = createWorktreeRepository(database)
  const tasks = createTaskRepository(database)
  const runs = createAgentRunRepository(database)
  const handoffs = createHandoffRepository(database)
  const criteria = createCriteriaRepository(database)
  const workflowRuns = createWorkflowRunRepository(database)
  const workspace = workspaces.create(
    {
      id: 'workspace-1',
      name: 'Dispatch fixture',
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      path: repoDir,
    },
    '2026-09-10T00:00:00.000Z',
  )
  if (!workspace.ok) throw new Error(workspace.error.message)
  const task = tasks.create(
    {
      id: 'task-1',
      workspaceId: 'workspace-1',
      title: 'Dispatch this task',
      description: 'Implement the dispatch fixture change.',
    },
    '2026-09-10T00:00:00.000Z',
  )
  if (!task.ok) throw new Error(task.error.message)
  const criteriaSet = criteria.createSet(
    { id: 'set-1', taskId: 'task-1', version: 1, status: 'confirmed' },
    '2026-09-10T00:00:00.000Z',
  )
  if (!criteriaSet.ok) throw new Error(criteriaSet.error.message)
  const criterion = criteria.addCriterion(
    {
      id: 'criterion-1',
      criteriaSetId: 'set-1',
      ordinal: 1,
      description: 'The dispatch fixture acceptance criterion',
    },
    '2026-09-10T00:00:00.000Z',
  )
  if (!criterion.ok) throw new Error(criterion.error.message)

  const events = createEventBus<WorkbenchEvents>()
  const paths = createTeskraPaths({ TESKRA_HOME: dataRoot })
  const resolveRuntime = (candidate: typeof workspace.data) =>
    createWorkspaceRuntime(candidate.runtime, { hostPlatform: 'linux', paths })
  const worktreeManager = createWorktreeManager({
    commands,
    workspaces,
    worktrees,
    events,
    resolveRuntime,
  })
  const registry = createDefaultAgentRegistry(true)
  if (!registry.ok) throw new Error(registry.error.message)
  const codex = mockAdapter(CODEX_AGENT)
  const fake = mockAdapter(FAKE_AGENT)
  let tick = 0
  const agents = createAgentManager({
    registry: registry.data,
    adapters: [codex, fake],
    runs,
    agentEvents: createAgentEventRepository(database),
    handoffs,
    workspaces,
    tasks,
    worktrees,
    events,
    paths,
    runLogs: createRunLogStore({ paths }),
    now: () => `2026-09-10T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  })
  const runStore = createWorkflowRunStore({ workflowRuns, tasks })
  const engine = createWorkflowEngine({ runs: runStore, events, agentManager: agents })
  const promptTemplates = createPromptTemplateService({ paths })
  const service = createDispatchService({
    runs: runStore,
    engine,
    registry: registry.data,
    tasks,
    criteria,
    workspaces,
    worktreeManager,
    agents,
    handoffs,
    promptTemplates,
    paths,
    events,
  })
  return {
    service,
    events,
    commands,
    adapters: { codex, fake },
    agents,
    worktrees,
    handoffs,
    workflowRuns,
    paths,
    repoDir,
  }
}

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

function requireRecord<T>(result: IpcResult<T | null>): T {
  const data = requireOk(result)
  if (data === null) throw new Error('expected a record, got null')
  return data
}

function finishRun(fixture: Fixture, runId: string, agentId: string, exitCode = 0): void {
  fixture.events.emit('process.exited', {
    processId: `${agentId}:${runId}`,
    agentRunId: runId,
    exitCode,
  })
}

/** Waits for the mocked adapter launch and returns its start request. */
async function awaitAdapterStart(
  adapter: CodingAgentAdapter,
): Promise<Record<string, unknown> & { runId: string }> {
  await vi.waitFor(() => {
    expect(vi.mocked(adapter.start).mock.calls.length).toBeGreaterThan(0)
  })
  return vi.mocked(adapter.start).mock.calls.at(-1)?.[0] as Record<string, unknown> & {
    runId: string
  }
}

describe('DispatchService (TASK-059)', () => {
  it('dispatches the specified agent into a worktree and settles Task → Agent → Handoff', async () => {
    const fixture = await setup()

    const dispatched = fixture.service.dispatch({
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      agent: 'codex',
    })
    const start = await awaitAdapterStart(fixture.adapters.codex)
    expect(fixture.adapters.fake.start).not.toHaveBeenCalled()

    // The agent finishes by writing the ADR-0004 handoff file, then exiting.
    const runFiles = requireOk(fixture.paths.runFiles(start.runId))
    writeFileSync(
      runFiles.handoff,
      JSON.stringify({ runId: start.runId, type: 'implementation', summary: 'Dispatched.' }),
    )
    finishRun(fixture, start.runId, 'codex')

    const result = requireOk(await dispatched)

    // The AgentRun is orchestrated inside a real worktree (ADR-0002).
    expect(result.agentRun).toMatchObject({
      id: start.runId,
      agentType: 'codex',
      taskId: 'task-1',
      role: 'implementer',
      executionMode: 'orchestrated',
      worktreeId: result.worktree.id,
      status: 'completed',
    })
    expect(start.worktreePath).toBe(result.worktree.path)
    const worktree = requireRecord(fixture.worktrees.getById(result.worktree.id))
    expect(worktree).toMatchObject({
      runId: start.runId,
      isolation: 'worktree',
      branch: `agent/task-1/codex/${start.runId}`,
      state: 'ready',
    })

    // The prompt came from the 'implement' template with task, criteria and
    // the ADR-0004 handoff env paths injected (TASK-079).
    expect(start.prompt).toEqual(expect.stringContaining('Dispatch this task'))
    expect(start.prompt).toEqual(
      expect.stringContaining('The dispatch fixture acceptance criterion'),
    )
    expect(start.prompt).toEqual(expect.stringContaining(result.handoffPath))
    expect(start.prompt).toEqual(expect.stringContaining(runFiles.artifacts))

    // One uniform WorkflowRun record, settled by dispatch (engine leaves
    // 'waiting'; the caller owns the final fate).
    expect(result.run).toMatchObject({
      taskId: 'task-1',
      workflowDefinitionId: 'dispatch',
      status: 'completed',
    })
    const stored = requireRecord(fixture.workflowRuns.getRunById(result.run.id))
    expect(stored.definition.steps).toHaveLength(1)
    const steps = requireOk(fixture.workflowRuns.listSteps(result.run.id))
    expect(stored.status).toBe('completed')
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ nodeId: 'implement', nodeType: 'agent', status: 'completed' })

    // The handoff is persisted and queryable (teskra:handoff:get backing).
    expect(result.handoff).toMatchObject({ runId: start.runId, parseStatus: 'ok' })
    expect(requireRecord(fixture.handoffs.getByRunId(start.runId))).toMatchObject({
      type: 'implementation',
      parseStatus: 'ok',
    })
  })

  it('honors the requested worktree isolation tier', async () => {
    const fixture = await setup()

    const dispatched = fixture.service.dispatch({
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      agent: 'fake',
      isolation: 'disposable-snapshot',
      prompt: 'Explicit prompt wins over the template.',
    })
    const start = await awaitAdapterStart(fixture.adapters.fake)
    expect(start.prompt).toBe('Explicit prompt wins over the template.')
    finishRun(fixture, start.runId, 'fake')

    const result = requireOk(await dispatched)
    const worktree = requireRecord(fixture.worktrees.getById(result.worktree.id))
    expect(worktree).toMatchObject({
      isolation: 'disposable-snapshot',
      branch: `agent/task-1/fake/${start.runId}`,
    })
    expect(result.run.status).toBe('completed')
    // The fake agent wrote no handoff file: the collector still persists a
    // 'missing' fallback row (ADR-0004), so a handoff is always queryable.
    expect(result.handoff).toMatchObject({ runId: start.runId, parseStatus: 'missing' })
  })

  it('marks the WorkflowRun failed when the agent exits non-zero', async () => {
    const fixture = await setup()

    const dispatched = fixture.service.dispatch({
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      agent: 'codex',
    })
    const start = await awaitAdapterStart(fixture.adapters.codex)
    finishRun(fixture, start.runId, 'codex', 1)

    const result = requireOk(await dispatched)
    expect(result.run.status).toBe('failed')
    expect(result.agentRun.status).toBe('failed')
  })

  it('refuses unknown agents and tasks from another workspace without creating a worktree', async () => {
    const fixture = await setup()

    await expect(
      fixture.service.dispatch({ workspaceId: 'workspace-1', taskId: 'task-1', agent: 'nope' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    await expect(
      fixture.service.dispatch({ workspaceId: 'workspace-1', taskId: 'missing', agent: 'codex' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })

    expect(fixture.adapters.codex.start).not.toHaveBeenCalled()
    // No linked worktree was created: only the main repository entry remains.
    const worktreeList = await fixture.commands.run({
      command: 'git',
      args: ['worktree', 'list', '--porcelain'],
      cwd: fixture.repoDir,
      timeoutMs: 15_000,
    })
    expect(requireOk(worktreeList).stdout.match(/^worktree /gmu)).toHaveLength(1)
  })

  it('never launches orchestrated without a worktree (ADR-0002 red line)', async () => {
    const fixture = await setup()

    // The red line itself: AgentManager refuses orchestrated runs with no
    // worktree, so there is no dispatch path that could skip isolation.
    await expect(
      fixture.agents.start({
        workspaceId: 'workspace-1',
        agentType: 'codex',
        executionMode: 'orchestrated',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: expect.stringContaining('worktree') },
    })

    // And every dispatch binds a worktree before the engine launches the run.
    const dispatched = fixture.service.dispatch({
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      agent: 'codex',
    })
    const start = await awaitAdapterStart(fixture.adapters.codex)
    expect(start.worktreePath).toBeDefined()
    finishRun(fixture, start.runId, 'codex')
    const result = requireOk(await dispatched)
    expect(result.agentRun.executionMode).toBe('orchestrated')
    expect(result.agentRun.worktreeId).toBe(result.worktree.id)
  })
})
