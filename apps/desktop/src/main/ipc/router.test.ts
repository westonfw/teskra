import { describe, expect, it, vi } from 'vitest'

import {
  IPC_CHANNELS,
  ipcChannelDefinitions,
  type AcceptanceCriteriaSet,
  type AcceptanceCriterion,
  type AccountLoginSession,
  type AgentAccountProfile,
  type AgentExecutionProfile,
  type AgentRun,
  type IpcResult,
  type ProfileAlias,
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
  trustLevel: 'trusted',
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

const ACCOUNT_PROFILE: AgentAccountProfile = {
  id: 'acct-1',
  agentId: 'codex',
  name: 'Codex Personal',
  authType: 'subscription',
  runtime: { kind: 'wsl', distro: 'Ubuntu' },
  configHome: '/home/dev/.teskra/agent-profiles/codex/personal',
  maxConcurrentRuns: 1,
  status: 'login-required',
  enabled: true,
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

const LOGIN_SESSION: AccountLoginSession = {
  sessionId: 'sess-1',
  profileId: 'acct-1',
  startedAt: '2026-09-10T00:00:00.000Z',
}

const PROFILE_ALIAS: ProfileAlias = {
  agentId: 'codex',
  kind: 'account',
  alias: 'work',
  profileId: 'acct-1',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

const EXECUTION_PROFILE: AgentExecutionProfile = {
  id: 'exec-1',
  name: 'Codex Personal High',
  agentId: 'codex',
  accountProfileId: 'acct-1',
  model: 'gpt-5-codex',
  reasoningEffort: 'high',
  approvalMode: 'safe-auto',
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
      updateTrust: vi.fn(() => ok(WORKSPACE)),
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
    memory: {
      list: vi.fn(() => ok([])),
      get: vi.fn(() => ok(null)),
      create: vi.fn(() => {
        throw new Error('not used')
      }),
      update: vi.fn(() => ok(null)),
      delete: vi.fn(() => ok(true)),
    },
    context: {
      preview: vi.fn(() =>
        ok({
          workspaceId: 'ws-1',
          budgetChars: 8000,
          totalChars: 0,
          omittedCount: 0,
          parts: [],
          content: '',
        }),
      ),
    },
    permission: {
      listRules: vi.fn(() => ok([])),
      createRule: vi.fn(() => {
        throw new Error('not used')
      }),
      updateRule: vi.fn(() => ok(null)),
      deleteRule: vi.fn(() => ok(true)),
      listAudit: vi.fn(() => ok([])),
      resolveProfile: vi.fn(() => {
        throw new Error('not used')
      }),
      resolveDecision: vi.fn(() => {
        throw new Error('not used')
      }),
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
      continueWithProfile: vi.fn(async () => {
        throw new Error('not used')
      }),
      send: vi.fn(async () => ok(undefined)),
      resize: vi.fn(() => ok(undefined)),
      cancel: vi.fn(async () => {
        throw new Error('not used')
      }),
      get: vi.fn(() => ok(null)),
      list: vi.fn(() => ok([])),
      getOutput: vi.fn(() => ok('')),
    },
    account: {
      list: vi.fn(async () => ok([])),
      listAdapterAgents: vi.fn(async () => ok(['codex', 'claude', 'kimi'])),
      get: vi.fn(async () => ok(null)),
      create: vi.fn(async () => ok(ACCOUNT_PROFILE)),
      update: vi.fn(async () => ok(ACCOUNT_PROFILE)),
      remove: vi.fn(async () => ok({ ...ACCOUNT_PROFILE, enabled: false })),
      disable: vi.fn(async () => ok({ ...ACCOUNT_PROFILE, enabled: false })),
      enable: vi.fn(async () => ok(ACCOUNT_PROFILE)),
      detect: vi.fn(async () => ok({ ...ACCOUNT_PROFILE, status: 'ready' as const })),
      setDefault: vi.fn(async () => ok(undefined)),
      getDefault: vi.fn(async () => ok(undefined)),
      startLogin: vi.fn(async () => ok(LOGIN_SESSION)),
      writeLogin: vi.fn(async () => ok(undefined)),
      resizeLogin: vi.fn(async () => ok(undefined)),
      cancelLogin: vi.fn(async () => ok(undefined)),
      listAliases: vi.fn(async () => ok([])),
      bindAlias: vi.fn(async () => ok(PROFILE_ALIAS)),
      unbindAlias: vi.fn(async () => ok(true)),
    },
    executionProfile: {
      list: vi.fn(async () => ok([])),
      get: vi.fn(async () => ok(null)),
      create: vi.fn(async () => ok(EXECUTION_PROFILE)),
      update: vi.fn(async () => ok(EXECUTION_PROFILE)),
      remove: vi.fn(async () => ok(true)),
      setDefault: vi.fn(async () => ok(undefined)),
      getDefault: vi.fn(async () => ok(undefined)),
    },
    git: {
      status: vi.fn(async () => ok({ ahead: 0, behind: 0, clean: true, entries: [] })),
      branch: vi.fn(async () => ok({ current: 'main', detached: false, branches: ['main'] })),
      diff: vi.fn(async () => ok({ patch: '' })),
      log: vi.fn(async () => ok([])),
      commit: vi.fn(async () => ok({ hash: 'abc', output: 'committed' })),
      changes: vi.fn(async () => ok({ files: [] })),
      filePatch: vi.fn(async () => ok({ patch: '' })),
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
    maintenance: {
      planRetention: vi.fn(async () =>
        ok({
          generatedAt: '2026-09-10T00:00:00.000Z',
          policy: { mergedWorktreeDays: 1, completedRunLogsDays: 30, discardedRunDays: 30 },
          items: [],
        }),
      ),
      runRetention: vi.fn(async () =>
        ok({
          startedAt: '2026-09-10T00:00:00.000Z',
          finishedAt: '2026-09-10T00:00:00.000Z',
          dryRun: false,
          cancelled: false,
          policy: { mergedWorktreeDays: 1, completedRunLogsDays: 30, discardedRunDays: 30 },
          entries: [],
        }),
      ),
      cancelRetention: vi.fn(() => ok(false)),
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
    recovery: {
      list: vi.fn(async () =>
        ok({ generatedAt: '2026-09-10T00:00:00.000Z', workspaceId: 'ws1', issues: [] }),
      ),
    },
    credential: {
      status: vi.fn(() => ok({ available: true })),
      set: vi.fn(() => ok(undefined)),
      delete: vi.fn(() => ok(true)),
      list: vi.fn(() => ok(['OPENAI_API_KEY'])),
    },
    settings: {
      resolveConfig: vi.fn(() =>
        ok({
          config: {
            logging: { level: 'info' as const },
            concurrency: { maxGlobalRuns: 4, maxRunsPerWorkspace: 3, maxRunsPerAgent: 2 },
            watchdog: { stalledThresholdMs: 600_000 },
            environment: { defaultDistro: null },
            agents: {
              executableOverrides: {},
              defaultAccountProfiles: {},
              defaultExecutionProfiles: {},
            },
            review: { mediumBlockThreshold: 0 },
            retention: { mergedWorktreeDays: 1, completedRunLogsDays: 30, discardedRunDays: 30 },
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
            agents: {
              executableOverrides: {},
              defaultAccountProfiles: {},
              defaultExecutionProfiles: {},
            },
            review: { mediumBlockThreshold: 0 },
            retention: { mergedWorktreeDays: 1, completedRunLogsDays: 30, discardedRunDays: 30 },
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
      completeRun: vi.fn(async () => ok({ ...WORKFLOW_RUN, status: 'completed' as const })),
      resolveStep: vi.fn(() => ok(WORKFLOW_STEP)),
      confirmShellStep: vi.fn(() => ok(true)),
      listPendingShellConfirmations: vi.fn(() => ok([])),
      dispatch: vi.fn(async () => ok(DISPATCH_RESULT)),
      iterate: vi.fn(async () =>
        ok({ run: WORKFLOW_RUN, rounds: 1, stopReason: 'passed' as const }),
      ),
      startFullWorkflow: vi.fn(async () =>
        ok({ run: WORKFLOW_RUN, worktree: WORKTREE, rounds: 1, stopReason: 'passed' as const }),
      ),
      runSummary: vi.fn(async () =>
        ok({
          run: WORKFLOW_RUN,
          steps: [WORKFLOW_STEP],
          worktree: WORKTREE,
          diff: null,
          criteria: [],
          criterionScores: [],
          criteriaOutcome: null,
        }),
      ),
    },
    dispose: vi.fn(async () => ok(undefined)),
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
    // Word-boundary: "executionProfile*" keys are execution PROFILE channels,
    // not a generic exec endpoint.
    expect(Object.keys(IPC_CHANNELS).some((name) => /\bexec\b/iu.test(name))).toBe(false)
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

  it('routes the default full workflow launch and summary through the runtime facade (TASK-063)', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    const startRequest = { workspaceId: 'ws1', taskId: 'task1' }
    expect(await ipc.invoke(IPC_CHANNELS.workflowStartFull, startRequest)).toEqual({
      ok: true,
      data: { run: WORKFLOW_RUN, worktree: WORKTREE, rounds: 1, stopReason: 'passed' },
    })
    expect(runtime.workflow.startFullWorkflow).toHaveBeenCalledWith(startRequest)

    expect(await ipc.invoke(IPC_CHANNELS.workflowRunSummary, { runId: 'wr-1' })).toEqual({
      ok: true,
      data: {
        run: WORKFLOW_RUN,
        steps: [WORKFLOW_STEP],
        worktree: WORKTREE,
        diff: null,
        criteria: [],
        criterionScores: [],
        criteriaOutcome: null,
      },
    })
    expect(runtime.workflow.runSummary).toHaveBeenCalledWith({ runId: 'wr-1' })

    const invalidStart = await ipc.invoke(IPC_CHANNELS.workflowStartFull, { workspaceId: 'ws1' })
    expect(invalidStart).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(runtime.workflow.startFullWorkflow).toHaveBeenCalledTimes(1)
  })

  it('routes account profile CRUD and detect through the runtime facade (TASK-102)', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    expect(await ipc.invoke(IPC_CHANNELS.accountList, { agentId: 'codex' })).toEqual({
      ok: true,
      data: [],
    })
    expect(runtime.account.list).toHaveBeenCalledWith({ agentId: 'codex' })

    expect(await ipc.invoke(IPC_CHANNELS.accountListAdapterAgents, {})).toEqual({
      ok: true,
      data: ['codex', 'claude', 'kimi'],
    })
    expect(runtime.account.listAdapterAgents).toHaveBeenCalledWith({})
    // The request schema is strict — extra keys are rejected before the facade.
    const smuggled = await ipc.invoke(IPC_CHANNELS.accountListAdapterAgents, { agentId: 'kimi' })
    expect(smuggled).toMatchObject({ ok: false })

    expect(await ipc.invoke(IPC_CHANNELS.accountGet, { id: 'acct-1' })).toEqual({
      ok: true,
      data: null,
    })
    expect(runtime.account.get).toHaveBeenCalledWith({ id: 'acct-1' })

    const createRequest = {
      agentId: 'codex',
      name: 'Codex Personal',
      authType: 'subscription',
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      slug: 'personal',
    }
    expect(await ipc.invoke(IPC_CHANNELS.accountCreate, createRequest)).toEqual({
      ok: true,
      data: ACCOUNT_PROFILE,
    })
    expect(runtime.account.create).toHaveBeenCalledWith(createRequest)

    const updateRequest = { id: 'acct-1', patch: { name: 'Renamed', maxConcurrentRuns: 2 } }
    expect(await ipc.invoke(IPC_CHANNELS.accountUpdate, updateRequest)).toEqual({
      ok: true,
      data: ACCOUNT_PROFILE,
    })
    expect(runtime.account.update).toHaveBeenCalledWith(updateRequest)

    const removeRequest = { id: 'acct-1', deleteHome: true }
    expect(await ipc.invoke(IPC_CHANNELS.accountRemove, removeRequest)).toEqual({
      ok: true,
      data: { ...ACCOUNT_PROFILE, enabled: false },
    })
    expect(runtime.account.remove).toHaveBeenCalledWith(removeRequest)

    expect(await ipc.invoke(IPC_CHANNELS.accountDisable, { id: 'acct-1' })).toEqual({
      ok: true,
      data: { ...ACCOUNT_PROFILE, enabled: false },
    })
    expect(runtime.account.disable).toHaveBeenCalledWith({ id: 'acct-1' })

    expect(await ipc.invoke(IPC_CHANNELS.accountEnable, { id: 'acct-1' })).toEqual({
      ok: true,
      data: ACCOUNT_PROFILE,
    })
    expect(runtime.account.enable).toHaveBeenCalledWith({ id: 'acct-1' })

    expect(await ipc.invoke(IPC_CHANNELS.accountDetect, { id: 'acct-1' })).toEqual({
      ok: true,
      data: { ...ACCOUNT_PROFILE, status: 'ready' },
    })
    expect(runtime.account.detect).toHaveBeenCalledWith({ id: 'acct-1' })

    const defaultRequest = { agentId: 'codex', profileId: 'acct-1' }
    expect(await ipc.invoke(IPC_CHANNELS.accountSetDefault, defaultRequest)).toEqual({
      ok: true,
      data: undefined,
    })
    expect(runtime.account.setDefault).toHaveBeenCalledWith(defaultRequest)
  })

  it('routes execution profile CRUD and set-default through the runtime facade (TASK-110)', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    expect(await ipc.invoke(IPC_CHANNELS.executionProfileList, { agentId: 'codex' })).toEqual({
      ok: true,
      data: [],
    })
    expect(runtime.executionProfile.list).toHaveBeenCalledWith({ agentId: 'codex' })

    expect(await ipc.invoke(IPC_CHANNELS.executionProfileGet, { id: 'exec-1' })).toEqual({
      ok: true,
      data: null,
    })
    expect(runtime.executionProfile.get).toHaveBeenCalledWith({ id: 'exec-1' })

    const createRequest = {
      agentId: 'codex',
      name: 'Codex Personal High',
      accountProfileId: 'acct-1',
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
      approvalMode: 'safe-auto',
    }
    expect(await ipc.invoke(IPC_CHANNELS.executionProfileCreate, createRequest)).toEqual({
      ok: true,
      data: EXECUTION_PROFILE,
    })
    expect(runtime.executionProfile.create).toHaveBeenCalledWith(createRequest)

    const updateRequest = { id: 'exec-1', patch: { name: 'Renamed', model: null } }
    expect(await ipc.invoke(IPC_CHANNELS.executionProfileUpdate, updateRequest)).toEqual({
      ok: true,
      data: EXECUTION_PROFILE,
    })
    expect(runtime.executionProfile.update).toHaveBeenCalledWith(updateRequest)

    expect(await ipc.invoke(IPC_CHANNELS.executionProfileRemove, { id: 'exec-1' })).toEqual({
      ok: true,
      data: true,
    })
    expect(runtime.executionProfile.remove).toHaveBeenCalledWith({ id: 'exec-1' })

    const defaultRequest = { agentId: 'codex', profileId: 'exec-1' }
    expect(await ipc.invoke(IPC_CHANNELS.executionProfileSetDefault, defaultRequest)).toEqual({
      ok: true,
      data: undefined,
    })
    expect(runtime.executionProfile.setDefault).toHaveBeenCalledWith(defaultRequest)

    // Zod validation guards the channel before the facade is touched.
    const invalid = await ipc.invoke(IPC_CHANNELS.executionProfileCreate, { name: 'No agent' })
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(runtime.executionProfile.create).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid account requests with VALIDATION_FAILED instead of throwing (TASK-102)', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    // A managed profile must never carry configHome (§48.1).
    const managedWithHome = await ipc.invoke(IPC_CHANNELS.accountCreate, {
      agentId: 'codex',
      name: 'Bad',
      authType: 'subscription',
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      slug: 'bad',
      configHome: '/home/dev/.codex',
    })
    expect(managedWithHome).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })

    // configHome is immutable — it is rejected even inside the update patch.
    const updateWithHome = await ipc.invoke(IPC_CHANNELS.accountUpdate, {
      id: 'acct-1',
      patch: { configHome: '/home/dev/.codex' },
    })
    expect(updateWithHome).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })

    const badConcurrency = await ipc.invoke(IPC_CHANNELS.accountUpdate, {
      id: 'acct-1',
      patch: { maxConcurrentRuns: 0 },
    })
    expect(badConcurrency).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })

    const badSlug = await ipc.invoke(IPC_CHANNELS.accountCreate, {
      agentId: 'codex',
      name: 'Bad',
      authType: 'subscription',
      runtime: { kind: 'windows' },
      slug: 'not a slug!',
    })
    expect(badSlug).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })

    // A wsl profile must pin its distro (§7).
    const distroLess = await ipc.invoke(IPC_CHANNELS.accountCreate, {
      agentId: 'codex',
      name: 'Bad',
      authType: 'subscription',
      runtime: { kind: 'wsl' },
      slug: 'bad',
    })
    expect(distroLess).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })

    expect(runtime.account.create).not.toHaveBeenCalled()
    expect(runtime.account.update).not.toHaveBeenCalled()
  })

  it('routes the login session channels through the runtime facade (TASK-102 §24.2)', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    // start resolves immediately with the session handle.
    expect(await ipc.invoke(IPC_CHANNELS.accountLoginStart, { profileId: 'acct-1' })).toEqual({
      ok: true,
      data: LOGIN_SESSION,
    })
    expect(runtime.account.startLogin).toHaveBeenCalledWith({ profileId: 'acct-1' })

    expect(
      await ipc.invoke(IPC_CHANNELS.accountLoginWrite, { sessionId: 'sess-1', data: '\r' }),
    ).toEqual({ ok: true, data: undefined })
    expect(runtime.account.writeLogin).toHaveBeenCalledWith({ sessionId: 'sess-1', data: '\r' })

    expect(
      await ipc.invoke(IPC_CHANNELS.accountLoginResize, {
        sessionId: 'sess-1',
        cols: 120,
        rows: 30,
      }),
    ).toEqual({ ok: true, data: undefined })
    expect(runtime.account.resizeLogin).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      cols: 120,
      rows: 30,
    })

    expect(await ipc.invoke(IPC_CHANNELS.accountLoginCancel, { sessionId: 'sess-1' })).toEqual({
      ok: true,
      data: undefined,
    })
    expect(runtime.account.cancelLogin).toHaveBeenCalledWith({ sessionId: 'sess-1' })

    // §24.1: the Renderer submits only ids — command/env fields are rejected.
    const withCommand = await ipc.invoke(IPC_CHANNELS.accountLoginStart, {
      profileId: 'acct-1',
      command: 'codex login',
    })
    expect(withCommand).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    const badResize = await ipc.invoke(IPC_CHANNELS.accountLoginResize, {
      sessionId: 'sess-1',
      cols: 0,
      rows: 30,
    })
    expect(badResize).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(runtime.account.startLogin).toHaveBeenCalledTimes(1)
    expect(runtime.account.resizeLogin).toHaveBeenCalledTimes(1)
  })

  it('routes the alias channels through the runtime facade (TASK-111 §28)', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    expect(await ipc.invoke(IPC_CHANNELS.accountAliasList, { agentId: 'codex' })).toEqual({
      ok: true,
      data: [],
    })
    expect(runtime.account.listAliases).toHaveBeenCalledWith({ agentId: 'codex' })

    expect(
      await ipc.invoke(IPC_CHANNELS.accountAliasBind, {
        agentId: 'codex',
        kind: 'account',
        alias: 'work',
        profileId: 'acct-1',
      }),
    ).toEqual({ ok: true, data: PROFILE_ALIAS })
    expect(runtime.account.bindAlias).toHaveBeenCalledWith({
      agentId: 'codex',
      kind: 'account',
      alias: 'work',
      profileId: 'acct-1',
    })

    expect(
      await ipc.invoke(IPC_CHANNELS.accountAliasUnbind, {
        agentId: 'codex',
        kind: 'account',
        alias: 'work',
      }),
    ).toEqual({ ok: true, data: true })

    // kind is required — the (agentId, kind, alias) primary key cannot be
    // inferred from the profileId (§28).
    const kindless = await ipc.invoke(IPC_CHANNELS.accountAliasBind, {
      agentId: 'codex',
      alias: 'work',
      profileId: 'acct-1',
    })
    expect(kindless).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    const badKind = await ipc.invoke(IPC_CHANNELS.accountAliasBind, {
      agentId: 'codex',
      kind: 'tool',
      alias: 'work',
      profileId: 'acct-1',
    })
    expect(badKind).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(runtime.account.bindAlias).toHaveBeenCalledTimes(1)
  })

  it('returns a clone-safe capability signal instead of the live runtime port', async () => {
    const ipc = new FakeIpcMain()
    registerIpcRouter(ipc, fakeRuntime)

    const result = (await ipc.invoke(IPC_CHANNELS.runtimeRequireCapability, {
      name: 'task',
    })) as IpcResult<unknown>
    expect(result.ok).toBe(true)
    // The response crosses Electron structured clone; a live port object with
    // methods would make ipcRenderer.invoke reject with an unstructured error
    // instead of resolving to an IpcResult.
    expect(() => structuredClone(result)).not.toThrow()
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
