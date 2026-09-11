import { describe, expect, it, vi } from 'vitest'

import {
  IPC_CHANNELS,
  ipcChannelDefinitions,
  type AcceptanceCriteriaSet,
  type AcceptanceCriterion,
  type AgentRun,
  type IpcResult,
  type Task,
  type WorkflowDispatchResult,
  type WorkflowRun,
  type WorkflowRunDetail,
  type WorkflowStep,
  type Workspace,
  type Worktree,
} from '@teskra/contracts'

import type { TeskraRuntime } from '../runtime/facade'
import { registerIpcRouter, type IpcMainPort } from './router'
import { createEventBus } from '../events/event-bus'

class FakeIpcMain implements IpcMainPort {
  readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`)
    this.handlers.set(channel, listener)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  async invoke(channel: string, payload?: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (handler === undefined) throw new Error(`missing handler: ${channel}`)
    return handler({}, payload)
  }
}

const WORKSPACE: Workspace = {
  id: 'ws1',
  name: 'Demo',
  runtime: { kind: 'wsl', distro: 'Ubuntu' },
  path: '/repo',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

const TASK: Task = {
  id: 'task1',
  workspaceId: 'ws1',
  title: 'Demo Task',
  status: 'draft',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

const CRITERIA_SET: AcceptanceCriteriaSet = {
  id: 'set-1',
  taskId: 'task1',
  version: 1,
  status: 'confirmed',
  confirmedAt: '2026-09-10T00:00:00.000Z',
  createdAt: '2026-09-10T00:00:00.000Z',
}

const CRITERION: AcceptanceCriterion = {
  id: 'criterion-1',
  criteriaSetId: 'set-1',
  ordinal: 1,
  description: 'All unit tests pass',
  category: 'test',
  required: true,
  createdAt: '2026-09-10T00:00:00.000Z',
}

const WORKTREE: Worktree = {
  id: 'wt1',
  workspaceId: 'ws1',
  runId: 'run-1',
  branch: 'agent/run-1',
  baseBranch: 'main',
  path: '/data/worktrees/ws1/run-1',
  state: 'ready',
  isolation: 'worktree',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

const AGENT_RUN: AgentRun = {
  id: 'run-2',
  workspaceId: 'ws1',
  agentType: 'codex',
  role: 'reviewer',
  approvalMode: 'read-only',
  status: 'running',
  executionMode: 'attended',
  runDir: '/data/runs/run-2',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

const WORKFLOW_RUN: WorkflowRun = {
  id: 'wr-1',
  taskId: 'task1',
  workflowDefinitionId: 'dispatch',
  definition: {
    id: 'dispatch',
    steps: [{ id: 'implement', type: 'agent', agent: 'codex', runOn: 'always' }],
  },
  status: 'running',
  currentIteration: 0,
  totalIterations: 1,
  criteriaIteration: 0,
  createdAt: '2026-09-10T00:00:00.000Z',
}

const WORKFLOW_STEP: WorkflowStep = {
  id: 'step-1',
  workflowRunId: 'wr-1',
  nodeId: 'implement',
  nodeType: 'agent',
  status: 'running',
  iteration: 0,
  attempt: 1,
  createdAt: '2026-09-10T00:00:00.000Z',
}

const WORKFLOW_RUN_DETAIL: WorkflowRunDetail = { run: WORKFLOW_RUN, steps: [WORKFLOW_STEP] }

const DISPATCH_RESULT: WorkflowDispatchResult = {
  run: { ...WORKFLOW_RUN, status: 'completed' },
  agentRun: AGENT_RUN,
  worktree: WORKTREE,
  handoffPath: '/data/runs/run-2/handoff.json',
  handoff: null,
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function fakeRuntime(): TeskraRuntime {
  return {
    events: createEventBus(),
    workspace: {
      create: vi.fn(() => ok(WORKSPACE)),
      open: vi.fn(() => ok(WORKSPACE)),
      remove: vi.fn(() => ok(true)),
      listRecent: vi.fn(() => ok([WORKSPACE])),
      validate: vi.fn(() => ok({ exists: true })),
      selectDirectory: vi.fn(async () => ok('/repo')),
    },
    task: {
      create: vi.fn(() => ok(TASK)),
      update: vi.fn(() => ok(TASK)),
      archive: vi.fn(() => ok(TASK)),
      delete: vi.fn(() => ok(true)),
      get: vi.fn(() => ok(TASK)),
      list: vi.fn(() => ok([TASK])),
    },
    criteria: {
      listSets: vi.fn(() => ok([CRITERIA_SET])),
      getSet: vi.fn(() => ok({ set: CRITERIA_SET, criteria: [CRITERION] })),
      createSet: vi.fn(() => ok({ set: CRITERIA_SET, criteria: [] })),
      addCriterion: vi.fn(() => ok(CRITERION)),
      updateCriterion: vi.fn(() => ok(CRITERION)),
      removeCriterion: vi.fn(() => ok(true)),
      confirmSet: vi.fn(() => ok(CRITERIA_SET)),
      supersedeSet: vi.fn(() => ok(CRITERIA_SET)),
      bindRun: vi.fn(() => {
        throw new Error('not used')
      }),
    },
    artifact: {
      record: vi.fn(() => {
        throw new Error('not used')
      }),
      list: vi.fn(() => ok([])),
      get: vi.fn(() => ok(null)),
      scanRun: vi.fn(() => ok([])),
    },
    handoff: {
      get: vi.fn(() => ok(null)),
    },
    review: {
      listFindings: vi.fn(() => ok([])),
      listCriterionScores: vi.fn(() => ok([])),
      startPanel: vi.fn(() => {
        throw new Error('not used')
      }),
      getPanel: vi.fn(() => ok(null)),
      listPanels: vi.fn(() => ok([])),
    },
    terminal: {
      create: vi.fn(() =>
        ok({
          id: 'term1',
          workspaceId: 'ws1',
          shell: 'bash' as const,
          processId: 'proc1',
          title: 'Bash',
          createdAt: '2026-09-10T00:00:00.000Z',
        }),
      ),
      write: vi.fn(() => ok(undefined)),
      resize: vi.fn(() => ok(undefined)),
      close: vi.fn(async () => ok(undefined)),
      get: vi.fn(() => ok(null)),
      list: vi.fn(() => ok([])),
    },
    agent: {
      listDefinitions: vi.fn(() => ok([])),
      detect: vi.fn(async () =>
        ok({
          agentId: 'codex',
          runtime: { kind: 'windows' as const },
          installed: false,
          overridden: false,
          fromCache: false,
          checkedAt: '2026-09-10T00:00:00.000Z',
        }),
      ),
      listDetections: vi.fn(async () => ok([])),
      checkHealth: vi.fn(async () =>
        ok({
          agentId: 'codex',
          runtime: { kind: 'windows' as const },
          installed: false,
          available: false,
          checkedAt: '2026-09-10T00:00:00.000Z',
        }),
      ),
      listHealth: vi.fn(async () => ok([])),
      getExecutableOverride: vi.fn(() => ok<string | null>(null)),
      setExecutableOverride: vi.fn(() => ok<string | null>(null)),
      start: vi.fn(async () => {
        throw new Error('not used')
      }),
      startReview: vi.fn(async () => {
        throw new Error('not used')
      }),
      resume: vi.fn(async () => {
        throw new Error('not used')
      }),
      send: vi.fn(async () => ok(undefined)),
      cancel: vi.fn(async () => {
        throw new Error('not used')
      }),
      get: vi.fn(() => ok(null)),
      list: vi.fn(() => ok([])),
      getOutput: vi.fn(() => ok('')),
    },
    git: {
      status: vi.fn(async () => ok({ ahead: 0, behind: 0, clean: true, entries: [] })),
      branch: vi.fn(async () => ok({ current: 'main', detached: false, branches: ['main'] })),
      diff: vi.fn(async () => ok({ patch: '' })),
      log: vi.fn(async () => ok([])),
      commit: vi.fn(async () => ok({ hash: 'abc', output: 'committed' })),
      changes: vi.fn(async () => ok({ files: [] })),
      openFile: vi.fn(async () => ok(undefined)),
    },
    worktree: {
      create: vi.fn(async () => ok(WORKTREE)),
      list: vi.fn(async () => ok([WORKTREE])),
      validate: vi.fn(async () => ok(WORKTREE)),
      preflight: vi.fn(async () => ok({ worktreeId: 'wt1', status: 'pass' as const, checks: [] })),
      merge: vi.fn(async () =>
        ok({ worktreeId: 'wt1', outcome: 'merged' as const, worktree: WORKTREE }),
      ),
      discard: vi.fn(async () => ok(WORKTREE)),
      archive: vi.fn(async () => ok(WORKTREE)),
      cleanup: vi.fn(async () =>
        ok({ workspaceId: 'ws1', prunedRecordIds: [], removedDirectoryIds: [], skippedIds: [] }),
      ),
    },
    system: {
      info: vi.fn(() => ok({ appVersion: '0.1.0', runtimeVersion: '22.0.0' })),
      paths: vi.fn(() =>
        ok({
          dataDirectory: '/data',
          logDirectory: '/data/logs',
          databaseFile: '/data/db',
        }),
      ),
      health: vi.fn(async () => ok({ databaseAvailable: true, wslAvailable: true, issues: [] })),
      inspectWsl: vi.fn(async () => ok({ supportsCd: true, distributions: [] })),
      listWslDistributions: vi.fn(async () => ok([])),
      getDefaultWslDistribution: vi.fn(async () => ok<string | null>(null)),
      setDefaultWslDistribution: vi.fn(async (name: string | null) => ok(name)),
      doctor: vi.fn(async () =>
        ok({
          generatedAt: '2026-09-10T00:00:00.000Z',
          severity: 'info' as const,
          issueCount: 0,
          checks: [],
        }),
      ),
    },
    settings: {
      resolveConfig: vi.fn(() =>
        ok({
          config: {
            logging: { level: 'info' as const },
            concurrency: { maxGlobalRuns: 4, maxRunsPerWorkspace: 3, maxRunsPerAgent: 2 },
            watchdog: { stalledThresholdMs: 600_000 },
            environment: { defaultDistro: null },
            agents: { executableOverrides: {} },
            review: { mediumBlockThreshold: 0 },
          },
          sources: {
            'logging.level': 'default' as const,
            'concurrency.maxGlobalRuns': 'default' as const,
            'concurrency.maxRunsPerWorkspace': 'default' as const,
            'concurrency.maxRunsPerAgent': 'default' as const,
            'watchdog.stalledThresholdMs': 'default' as const,
            'environment.defaultDistro': 'default' as const,
            'review.mediumBlockThreshold': 'default' as const,
          },
          warnings: [],
        }),
      ),
      updateConfig: vi.fn(() =>
        ok({
          config: {
            logging: { level: 'warn' as const },
            concurrency: { maxGlobalRuns: 4, maxRunsPerWorkspace: 3, maxRunsPerAgent: 2 },
            watchdog: { stalledThresholdMs: 600_000 },
            environment: { defaultDistro: null },
            agents: { executableOverrides: {} },
            review: { mediumBlockThreshold: 0 },
          },
          sources: { 'logging.level': 'global' as const },
          warnings: [],
        }),
      ),
      openDirectory: vi.fn(async () => ok(undefined)),
    },
    prompts: {
      list: vi.fn(() => ok([{ name: 'plan', source: 'builtin' as const }])),
      render: vi.fn(() =>
        ok({
          name: 'plan',
          source: 'builtin' as const,
          content: '# Plan the Task\n\nTitle: Demo Task',
        }),
      ),
    },
    workflow: {
      listDefinitions: vi.fn(() => ok([])),
      loadDefinition: vi.fn(() =>
        ok({
          id: 'full-review',
          steps: [
            {
              id: 'implement',
              type: 'agent' as const,
              agent: 'codex',
              runOn: 'always' as const,
            },
          ],
        }),
      ),
      listRuns: vi.fn(() => ok([])),
      getRun: vi.fn(() => ok(null)),
      startRun: vi.fn(async () => ok(WORKFLOW_RUN_DETAIL)),
      cancelRun: vi.fn(async () => ok({ ...WORKFLOW_RUN, status: 'cancelled' as const })),
      resolveStep: vi.fn(() => ok(WORKFLOW_STEP)),
      dispatch: vi.fn(async () => ok(DISPATCH_RESULT)),
      iterate: vi.fn(async () =>
        ok({ run: WORKFLOW_RUN, rounds: 1, stopReason: 'passed' as const }),
      ),
    },
    dispose: vi.fn(() => ok(undefined)),
  }
}

describe('Typed IPC Router (TASK-020)', () => {
  it('registers every shared channel and exposes no generic exec endpoint', () => {
    const ipc = new FakeIpcMain()
    registerIpcRouter(ipc, fakeRuntime)

    expect([...ipc.handlers.keys()].sort()).toEqual(
      Object.values(ipcChannelDefinitions)
        .map((definition) => definition.channel)
        .sort(),
    )
    expect(Object.keys(IPC_CHANNELS).some((name) => /exec/iu.test(name))).toBe(false)
    expect(Object.values(IPC_CHANNELS).some((name) => /:exec(?::|$)/u.test(name))).toBe(false)
  })

  it('validates every request before invoking the Facade', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    const invalid = await ipc.invoke(IPC_CHANNELS.workspaceCreate, {
      name: 'Missing runtime and path',
    })
    expect(invalid).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: `Invalid request for IPC channel "${IPC_CHANNELS.workspaceCreate}".`,
        retryable: false,
      },
    })
    expect(runtime.workspace.create).not.toHaveBeenCalled()

    const valid = await ipc.invoke(IPC_CHANNELS.workspaceCreate, {
      name: 'Demo',
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      path: '/repo',
    })
    expect(valid).toEqual({ ok: true, data: WORKSPACE })
    expect(runtime.workspace.create).toHaveBeenCalledTimes(1)
  })

  it('returns structured capability errors while runtime is unavailable', async () => {
    const ipc = new FakeIpcMain()
    registerIpcRouter(ipc, () => undefined)

    expect(await ipc.invoke(IPC_CHANNELS.ping)).toEqual({ ok: true, data: 'pong' })
    const result = await ipc.invoke(IPC_CHANNELS.terminalList, {})
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'CAPABILITY_NOT_AVAILABLE',
        message: 'Teskra Runtime is not available.',
        retryable: true,
      },
    })
  })

  it('lists Agent definitions through the runtime facade', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    expect(await ipc.invoke(IPC_CHANNELS.agentListDefinitions)).toEqual({ ok: true, data: [] })
    expect(runtime.agent.listDefinitions).toHaveBeenCalledOnce()
  })

  it('queries active Agent runs through the typed runtime facade', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    expect(await ipc.invoke(IPC_CHANNELS.agentRunList, { activeOnly: true })).toEqual({
      ok: true,
      data: [],
    })
    expect(runtime.agent.list).toHaveBeenCalledWith({ activeOnly: true })
  })

  it('routes a validated Doctor request through the runtime facade', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    expect(await ipc.invoke(IPC_CHANNELS.doctorRun, { workspaceId: 'ws1' })).toMatchObject({
      ok: true,
      data: { severity: 'info', issueCount: 0 },
    })
    expect(runtime.system.doctor).toHaveBeenCalledWith({ workspaceId: 'ws1' })
  })

  it('routes handoff lookups through the runtime facade (TASK-051)', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    expect(await ipc.invoke(IPC_CHANNELS.handoffGet, { runId: 'run-1' })).toEqual({
      ok: true,
      data: null,
    })
    expect(runtime.handoff.get).toHaveBeenCalledWith({ runId: 'run-1' })

    const invalid = await ipc.invoke(IPC_CHANNELS.handoffGet, {})
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(runtime.handoff.get).toHaveBeenCalledTimes(1)
  })

  it('routes review finding lookups through the runtime facade (TASK-053)', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    expect(await ipc.invoke(IPC_CHANNELS.reviewListFindings, { runId: 'run-1' })).toEqual({
      ok: true,
      data: [],
    })
    expect(runtime.review.listFindings).toHaveBeenCalledWith({ runId: 'run-1' })

    // The request must select exactly one scope.
    const invalid = await ipc.invoke(IPC_CHANNELS.reviewListFindings, {})
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(runtime.review.listFindings).toHaveBeenCalledTimes(1)
  })

  it('routes criterion score lookups through the runtime facade (TASK-054)', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    expect(await ipc.invoke(IPC_CHANNELS.reviewListCriterionScores, { taskId: 'task-1' })).toEqual({
      ok: true,
      data: [],
    })
    expect(runtime.review.listCriterionScores).toHaveBeenCalledWith({ taskId: 'task-1' })

    const invalid = await ipc.invoke(IPC_CHANNELS.reviewListCriterionScores, {
      runId: 'run-1',
      taskId: 'task-1',
    })
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(runtime.review.listCriterionScores).toHaveBeenCalledTimes(1)
  })

  it('routes reviewer launches through the runtime facade (TASK-052)', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    runtime.agent.startReview = vi.fn(async () =>
      ok({ run: AGENT_RUN, isolation: 'shared-readonly' as const }),
    )
    registerIpcRouter(ipc, () => runtime)

    const request = { workspaceId: 'ws1', agentType: 'codex' }
    expect(await ipc.invoke(IPC_CHANNELS.agentRunReviewStart, request)).toEqual({
      ok: true,
      data: { run: AGENT_RUN, isolation: 'shared-readonly' },
    })
    expect(runtime.agent.startReview).toHaveBeenCalledWith(request)

    const invalid = await ipc.invoke(IPC_CHANNELS.agentRunReviewStart, { agentType: 'codex' })
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(runtime.agent.startReview).toHaveBeenCalledTimes(1)
  })

  it('routes validated Task CRUD through the runtime facade', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    expect(
      await ipc.invoke(IPC_CHANNELS.taskCreate, {
        workspaceId: 'ws1',
        title: 'Demo Task',
      }),
    ).toEqual({ ok: true, data: TASK })
    expect(await ipc.invoke(IPC_CHANNELS.taskList, { workspaceId: 'ws1' })).toEqual({
      ok: true,
      data: [TASK],
    })
    expect(runtime.task.create).toHaveBeenCalledWith({ workspaceId: 'ws1', title: 'Demo Task' })
  })

  it('validates Facade responses and converts thrown errors', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    runtime.workspace.remove = vi.fn(() => ({
      ok: true,
      data: 'not boolean',
    })) as unknown as (request: { id: string }) => IpcResult<boolean>
    runtime.workspace.open = vi.fn(() => {
      throw new Error('boom')
    })
    registerIpcRouter(ipc, () => runtime)

    const malformed = await ipc.invoke(IPC_CHANNELS.workspaceRemove, { id: 'ws1' })
    expect(malformed).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
    const thrown = await ipc.invoke(IPC_CHANNELS.workspaceOpen, {
      runtime: { kind: 'wsl' },
      path: '/repo',
    })
    expect(thrown).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
  })

  it('renders a prompt template through the runtime facade (TASK-079)', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    const request = {
      name: 'plan',
      context: {
        task: { title: 'Demo Task', description: 'Describe it.' },
        env: { TESKRA_HANDOFF_PATH: '/tmp/handoff.json', TESKRA_ARTIFACT_DIR: '/tmp/artifacts' },
      },
    }
    expect(await ipc.invoke(IPC_CHANNELS.promptRender, request)).toEqual({
      ok: true,
      data: { name: 'plan', source: 'builtin', content: '# Plan the Task\n\nTitle: Demo Task' },
    })
    expect(runtime.prompts.render).toHaveBeenCalledWith(request)

    const invalid = await ipc.invoke(IPC_CHANNELS.promptRender, { name: 'UPPER CASE' })
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(runtime.prompts.render).toHaveBeenCalledTimes(1)
  })

  it('routes workflow definition queries through the runtime facade (TASK-055)', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    expect(await ipc.invoke(IPC_CHANNELS.workflowListDefinitions, { workspaceId: 'ws1' })).toEqual({
      ok: true,
      data: [],
    })
    expect(runtime.workflow.listDefinitions).toHaveBeenCalledWith({ workspaceId: 'ws1' })

    const loaded = await ipc.invoke(IPC_CHANNELS.workflowLoadDefinition, {
      workspaceId: 'ws1',
      definitionId: 'full-review',
    })
    expect(loaded).toMatchObject({ ok: true, data: { id: 'full-review' } })
    expect(runtime.workflow.loadDefinition).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      definitionId: 'full-review',
    })

    const invalid = await ipc.invoke(IPC_CHANNELS.workflowLoadDefinition, { workspaceId: 'ws1' })
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(runtime.workflow.loadDefinition).toHaveBeenCalledTimes(1)
  })

  it('routes workflow run queries through the runtime facade (TASK-056)', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    expect(await ipc.invoke(IPC_CHANNELS.workflowRunList, { status: 'running' })).toEqual({
      ok: true,
      data: [],
    })
    expect(runtime.workflow.listRuns).toHaveBeenCalledWith({ status: 'running' })

    expect(await ipc.invoke(IPC_CHANNELS.workflowRunGet, { runId: 'wr-1' })).toEqual({
      ok: true,
      data: null,
    })
    expect(runtime.workflow.getRun).toHaveBeenCalledWith({ runId: 'wr-1' })

    const invalid = await ipc.invoke(IPC_CHANNELS.workflowRunGet, {})
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(runtime.workflow.getRun).toHaveBeenCalledTimes(1)
  })

  it('routes workflow engine control and dispatch through the runtime facade (TASK-059)', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    const startRequest = { runId: 'wr-1', workspaceId: 'ws1', worktreeId: 'wt1' }
    expect(await ipc.invoke(IPC_CHANNELS.workflowRunStart, startRequest)).toEqual({
      ok: true,
      data: WORKFLOW_RUN_DETAIL,
    })
    expect(runtime.workflow.startRun).toHaveBeenCalledWith(startRequest)

    expect(await ipc.invoke(IPC_CHANNELS.workflowRunCancel, { runId: 'wr-1' })).toEqual({
      ok: true,
      data: { ...WORKFLOW_RUN, status: 'cancelled' },
    })
    expect(runtime.workflow.cancelRun).toHaveBeenCalledWith({ runId: 'wr-1' })

    const resolveRequest = { stepId: 'step-1', outcome: 'pass' }
    expect(await ipc.invoke(IPC_CHANNELS.workflowStepResolve, resolveRequest)).toEqual({
      ok: true,
      data: WORKFLOW_STEP,
    })
    expect(runtime.workflow.resolveStep).toHaveBeenCalledWith(resolveRequest)

    const dispatchRequest = {
      workspaceId: 'ws1',
      taskId: 'task1',
      agent: 'codex',
      isolation: 'worktree',
    }
    expect(await ipc.invoke(IPC_CHANNELS.workflowDispatch, dispatchRequest)).toEqual({
      ok: true,
      data: DISPATCH_RESULT,
    })
    expect(runtime.workflow.dispatch).toHaveBeenCalledWith(dispatchRequest)

    const invalidStart = await ipc.invoke(IPC_CHANNELS.workflowRunStart, { runId: 'wr-1' })
    expect(invalidStart).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(runtime.workflow.startRun).toHaveBeenCalledTimes(1)

    const invalidDispatch = await ipc.invoke(IPC_CHANNELS.workflowDispatch, {
      workspaceId: 'ws1',
      taskId: 'task1',
    })
    expect(invalidDispatch).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(runtime.workflow.dispatch).toHaveBeenCalledTimes(1)
  })

  it('removes all handlers on dispose without touching the runtime', () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    const router = registerIpcRouter(ipc, () => runtime)
    router.dispose()
    router.dispose()
    expect(ipc.handlers.size).toBe(0)
    expect(runtime.dispose).not.toHaveBeenCalled()
  })
})
