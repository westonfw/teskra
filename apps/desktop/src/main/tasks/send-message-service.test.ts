import { describe, expect, it, vi } from 'vitest'

import {
  IPC_NAME_MAX,
  type AgentAccountProfile,
  type AgentRun,
  type ContinueAgentRunRequest,
  type FullWorkflowStartResult,
  type IpcResult,
  type ResolvedRunDefaults,
  type ReviewRunStartResult,
  type StartAgentRunRequest,
  type StartReviewRunRequest,
  type Task,
  type WorkflowRun,
  type Worktree,
} from '@teskra/contracts'

import type { ResolvedNodeProfiles } from '../agents/profile-alias-manager'
import {
  createSendTaskMessageService,
  splitTaskMessageText,
  type SendTaskMessageServiceDeps,
} from './send-message-service'

const WORKSPACE_ID = 'ws-1'

const TASK: Task = {
  id: 'task-1',
  workspaceId: WORKSPACE_ID,
  title: 'Existing task',
  status: 'ready',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

const DEFAULTS: ResolvedRunDefaults = {
  agentType: 'codex',
  accountProfileId: 'acct-1',
  executionProfileId: 'exec-1',
  mode: 'exec',
  executionMode: 'orchestrated',
  approvalMode: 'safe-auto',
  isolation: 'worktree',
  reasons: [{ key: 'runDefaults.reason.agent.configured', params: { agent: 'codex' } }],
}

const WORKTREE: Worktree = {
  id: 'wt-1',
  workspaceId: WORKSPACE_ID,
  runId: 'run-1',
  path: '/data/worktrees/ws-1/run-1',
  branch: 'agent/task-1/codex/run-1',
  baseBranch: 'main',
  isolation: 'worktree',
  state: 'ready',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

function startedRun(request: StartAgentRunRequest): AgentRun {
  return {
    id: request.runId ?? 'run-1',
    workspaceId: request.workspaceId,
    ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
    agentType: request.agentType,
    status: 'running',
    executionMode: request.executionMode ?? 'orchestrated',
    runDir: `/data/runs/${request.runId ?? 'run-1'}`,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  }
}

function fakeDeps(overrides: Partial<SendTaskMessageServiceDeps> = {}) {
  const tasks = {
    create: vi.fn(
      (request: { workspaceId: string; title: string; description?: string }): IpcResult<Task> => ({
        ok: true,
        data: {
          ...TASK,
          id: 'task-new',
          title: request.title,
          ...(request.description === undefined ? {} : { description: request.description }),
        },
      }),
    ),
    get: vi.fn((): IpcResult<Task | null> => ({ ok: true, data: TASK })),
  }
  const defaults = {
    resolveDefaults: vi.fn(async (): Promise<IpcResult<ResolvedRunDefaults>> => ({
      ok: true,
      data: DEFAULTS,
    })),
  }
  const worktreeManager = {
    create: vi.fn(async (): Promise<IpcResult<Worktree>> => ({ ok: true, data: WORKTREE })),
    discard: vi.fn(async (): Promise<IpcResult<Worktree>> => ({ ok: true, data: WORKTREE })),
  }
  const agents = {
    start: vi.fn(async (request: StartAgentRunRequest): Promise<IpcResult<AgentRun>> => ({
      ok: true,
      data: startedRun(request),
    })),
    continueWithProfile: vi.fn(
      async (request: ContinueAgentRunRequest): Promise<IpcResult<AgentRun>> => ({
        ok: true,
        data: {
          id: 'run-continued',
          workspaceId: WORKSPACE_ID,
          taskId: TASK.id,
          agentType: request.targetAgentId,
          status: 'running',
          executionMode: 'orchestrated',
          runDir: '/data/runs/run-continued',
          createdAt: '2026-09-10T00:00:00.000Z',
          updatedAt: '2026-09-10T00:00:00.000Z',
        },
      }),
    ),
  }
  const reviewer = {
    startReview: vi.fn(
      async (request: StartReviewRunRequest): Promise<IpcResult<ReviewRunStartResult>> => ({
        ok: true,
        data: {
          run: {
            id: 'review-run-1',
            workspaceId: request.workspaceId,
            ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
            agentType: request.agentType,
            role: 'reviewer',
            status: 'running',
            executionMode: 'orchestrated',
            runDir: '/data/runs/review-run-1',
            createdAt: '2026-09-10T00:00:00.000Z',
            updatedAt: '2026-09-10T00:00:00.000Z',
          },
          isolation: 'worktree-readonly',
        },
      }),
    ),
  }
  const fullWorkflow = {
    start: vi.fn(async (): Promise<IpcResult<FullWorkflowStartResult>> => ({
      ok: true,
      data: {
        run: { id: 'wfrun-1' } as WorkflowRun,
        worktree: WORKTREE,
        rounds: 1,
        stopReason: 'passed',
      },
    })),
  }
  const profileAliases = {
    resolveAgentNodeProfiles: vi.fn((): IpcResult<ResolvedNodeProfiles> => ({
      ok: true,
      data: { accountProfileId: 'acct-aliased' },
    })),
  }
  const accountProfiles = {
    getById: vi.fn((id: string): IpcResult<AgentAccountProfile | null> => ({
      ok: true,
      data:
        id === 'acct-direct'
          ? ({ id: 'acct-direct', agentId: 'codex', name: 'Direct' } as AgentAccountProfile)
          : null,
    })),
  }
  const runs = {
    listByTask: vi.fn((): IpcResult<AgentRun[]> => ({ ok: true, data: [] })),
    listActive: vi.fn((): IpcResult<AgentRun[]> => ({ ok: true, data: [] })),
  }
  const worktrees = {
    getById: vi.fn((): IpcResult<Worktree | null> => ({ ok: true, data: WORKTREE })),
  }
  return {
    deps: {
      tasks,
      defaults,
      worktreeManager,
      agents,
      reviewer,
      fullWorkflow,
      profileAliases,
      accountProfiles,
      runs,
      worktrees,
      createAgentRunId: () => 'run-1',
      ...overrides,
    } satisfies SendTaskMessageServiceDeps,
    tasks,
    defaults,
    worktreeManager,
    agents,
    reviewer,
    fullWorkflow,
    profileAliases,
    accountProfiles,
    runs,
    worktrees,
  }
}

describe('splitTaskMessageText', () => {
  it('splits the first line as title and the rest as description', () => {
    expect(splitTaskMessageText('Fix the login page\nUse OAuth\nAdd tests')).toEqual({
      title: 'Fix the login page',
      description: 'Use OAuth\nAdd tests',
    })
  })

  it('trims the first line and omits an empty description', () => {
    expect(splitTaskMessageText('  Fix the login page  ')).toEqual({ title: 'Fix the login page' })
    expect(splitTaskMessageText('Title\n\n  ')).toEqual({ title: 'Title' })
  })

  it('truncates an overlong first line to IPC_NAME_MAX', () => {
    const title = 'x'.repeat(IPC_NAME_MAX + 50)
    expect(splitTaskMessageText(title).title).toHaveLength(IPC_NAME_MAX)
  })
})

describe('SendTaskMessageService (TASK-135)', () => {
  it('creates the Task from the first line and starts the first Run', async () => {
    const { deps, tasks, worktreeManager, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      workspaceId: WORKSPACE_ID,
      text: 'Fix the login page\nUse OAuth, keep sessions short',
    })

    expect(result).toEqual({ ok: true, data: { taskId: 'task-new', kind: 'run', id: 'run-1' } })
    expect(tasks.create).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      title: 'Fix the login page',
      description: 'Use OAuth, keep sessions short',
    })
    expect(worktreeManager.create).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      runId: 'run-1',
      taskId: 'task-new',
      agentId: 'codex',
      isolation: 'worktree',
    })
    expect(agents.start).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      taskId: 'task-new',
      agentType: 'codex',
      runId: 'run-1',
      worktreeId: WORKTREE.id,
      accountProfileId: 'acct-1',
      executionProfileId: 'exec-1',
      mode: 'exec',
      executionMode: 'orchestrated',
      approvalMode: 'safe-auto',
      prompt: 'Fix the login page\nUse OAuth, keep sessions short',
    })
  })

  it('binds the Run to the given taskId without creating a Task', async () => {
    const { deps, tasks, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: 'Add tests too',
    })

    expect(result).toEqual({ ok: true, data: { taskId: TASK.id, kind: 'run', id: 'run-1' } })
    expect(tasks.create).not.toHaveBeenCalled()
    expect(agents.start).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK.id, prompt: 'Add tests too' }),
    )
  })

  it('refuses a task from another workspace or a missing task', async () => {
    const foreign = fakeDeps()
    foreign.tasks.get.mockReturnValue({
      ok: true,
      data: { ...TASK, workspaceId: 'ws-other' },
    })
    const service = createSendTaskMessageService(foreign.deps)
    const wrong = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: 'hello',
    })
    expect(wrong).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(foreign.agents.start).not.toHaveBeenCalled()

    const missing = fakeDeps()
    missing.tasks.get.mockReturnValue({ ok: true, data: null })
    const gone = await createSendTaskMessageService(missing.deps).sendMessage({
      taskId: 'task-gone',
      workspaceId: WORKSPACE_ID,
      text: 'hello',
    })
    expect(gone).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(missing.agents.start).not.toHaveBeenCalled()
  })

  it('collapses leading blank lines into the trimmed body (the IPC schema trims text)', async () => {
    const { deps, tasks, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      workspaceId: WORKSPACE_ID,
      text: '\n\nonly details',
    })

    expect(result).toEqual({ ok: true, data: { taskId: 'task-new', kind: 'run', id: 'run-1' } })
    expect(tasks.create).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, title: 'only details' })
    expect(agents.start).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'only details' }))
  })

  it('propagates the no-Agent VALIDATION_FAILED without side effects', async () => {
    const noAgent = fakeDeps()
    noAgent.defaults.resolveDefaults.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'No installed Agent.', retryable: false },
    })
    const service = createSendTaskMessageService(noAgent.deps)

    const result = await service.sendMessage({ workspaceId: WORKSPACE_ID, text: 'hello' })

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(noAgent.tasks.create).not.toHaveBeenCalled()
    expect(noAgent.worktreeManager.create).not.toHaveBeenCalled()
  })

  it('applies per-send overrides but never attended + manual', async () => {
    const { deps, worktreeManager, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: 'Use another agent',
      overrides: { agentType: 'claude', accountProfileId: 'acct-2', executionProfileId: 'exec-2' },
    })

    expect(result.ok).toBe(true)
    expect(worktreeManager.create).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'claude' }),
    )
    const started = agents.start.mock.calls[0]?.[0]
    expect(started).toMatchObject({
      agentType: 'claude',
      accountProfileId: 'acct-2',
      executionProfileId: 'exec-2',
      // Thread-mode hard constraints are not overridable: the attended +
      // manual combination cannot be assembled through this entry point.
      mode: 'exec',
      executionMode: 'orchestrated',
      approvalMode: 'safe-auto',
    })
  })

  it('omits absent profile ids from the start request', async () => {
    const bare = fakeDeps()
    bare.defaults.resolveDefaults.mockResolvedValue({
      ok: true,
      data: { ...DEFAULTS, accountProfileId: undefined, executionProfileId: undefined },
    })
    const service = createSendTaskMessageService(bare.deps)

    await service.sendMessage({ taskId: TASK.id, workspaceId: WORKSPACE_ID, text: 'hello' })

    const started = bare.agents.start.mock.calls[0]?.[0]
    expect(started).not.toHaveProperty('accountProfileId')
    expect(started).not.toHaveProperty('executionProfileId')
  })

  it('propagates a worktree creation failure without starting the Run', async () => {
    const broken = fakeDeps()
    broken.worktreeManager.create.mockResolvedValue({
      ok: false,
      error: { code: 'UNKNOWN', message: 'worktree add failed', retryable: true },
    })
    const service = createSendTaskMessageService(broken.deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: 'hello',
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
    expect(broken.agents.start).not.toHaveBeenCalled()
  })

  it('discards the pre-built worktree when the Run start fails', async () => {
    const failing = fakeDeps()
    failing.agents.start.mockResolvedValue({
      ok: false,
      error: { code: 'UNKNOWN', message: 'spawn failed', retryable: true },
    })
    const service = createSendTaskMessageService(failing.deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: 'hello',
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
    // Allow the best-effort discard promise chain to run.
    await vi.waitFor(() => {
      expect(failing.worktreeManager.discard).toHaveBeenCalledWith({
        worktreeId: WORKTREE.id,
        confirm: true,
      })
    })
  })
})

describe('SendTaskMessageService directives (TASK-136)', () => {
  it('rejects an unknown directive with a keyed VALIDATION_FAILED and starts nothing', async () => {
    const { deps, tasks, worktreeManager, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      workspaceId: WORKSPACE_ID,
      text: '/agent codex\n/frobnicate x\nhello',
    })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        messageKey: 'errorMessage.messageDirectiveUnknown',
        params: { line: 2, directive: 'frobnicate' },
      },
    })
    expect(tasks.create).not.toHaveBeenCalled()
    expect(worktreeManager.create).not.toHaveBeenCalled()
    expect(agents.start).not.toHaveBeenCalled()
  })

  it('rejects directives without a body', async () => {
    const { deps, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: '/agent codex',
    })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', messageKey: 'errorMessage.messageDirectiveMissingBody' },
    })
    expect(agents.start).not.toHaveBeenCalled()
  })

  it('maps /agent /mode /approval /model onto the start request', async () => {
    const { deps, worktreeManager, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: '/agent claude\n/mode isolated\n/approval full-auto\n/model gpt-5\ndo the thing',
      // The defaults row edits lose to the more explicit message directives.
      overrides: { agentType: 'codex' },
    })

    expect(result).toEqual({ ok: true, data: { taskId: TASK.id, kind: 'run', id: 'run-1' } })
    expect(worktreeManager.create).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'claude' }),
    )
    expect(agents.start).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'claude',
        executionMode: 'orchestrated',
        approvalMode: 'full-auto',
        model: 'gpt-5',
        prompt: 'do the thing',
      }),
    )
  })

  it('creates the Task from the message body, not the directive lines', async () => {
    const { deps, tasks, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    await service.sendMessage({
      workspaceId: WORKSPACE_ID,
      text: '/agent claude\nFix the login page\nUse OAuth',
    })

    expect(tasks.create).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      title: 'Fix the login page',
      description: 'Use OAuth',
    })
    expect(agents.start).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-new', agentType: 'claude' }),
    )
  })

  it('resolves a /account alias through ProfileAliasManager (ADR-0011)', async () => {
    const { deps, accountProfiles, profileAliases, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: '/account work\ndo the thing',
    })

    expect(result.ok).toBe(true)
    expect(accountProfiles.getById).toHaveBeenCalledWith('work')
    expect(profileAliases.resolveAgentNodeProfiles).toHaveBeenCalledWith({
      agentId: 'codex',
      accountProfileAlias: 'work',
      source: 'send-message /account directive',
    })
    expect(agents.start).toHaveBeenCalledWith(
      expect.objectContaining({ accountProfileId: 'acct-aliased' }),
    )
  })

  it('accepts a machine-local /account profile id without alias resolution', async () => {
    const { deps, profileAliases, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: '/account acct-direct\ndo the thing',
    })

    expect(result.ok).toBe(true)
    expect(profileAliases.resolveAgentNodeProfiles).not.toHaveBeenCalled()
    expect(agents.start).toHaveBeenCalledWith(
      expect.objectContaining({ accountProfileId: 'acct-direct' }),
    )
  })

  it('propagates an unbound /account alias failure without side effects', async () => {
    const { deps, tasks, profileAliases, agents } = fakeDeps()
    profileAliases.resolveAgentNodeProfiles.mockReturnValue({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Profile alias "work" is not bound.',
        retryable: false,
      },
    })
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      workspaceId: WORKSPACE_ID,
      text: '/account work\ndo the thing',
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(tasks.create).not.toHaveBeenCalled()
    expect(agents.start).not.toHaveBeenCalled()
  })

  it('rejects /mode attended + /approval manual with an explanation', async () => {
    const { deps, tasks, worktreeManager, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      workspaceId: WORKSPACE_ID,
      text: '/mode attended\n/approval manual\ndo the thing',
    })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', messageKey: 'errorMessage.attendedManualRejected' },
    })
    expect(tasks.create).not.toHaveBeenCalled()
    expect(worktreeManager.create).not.toHaveBeenCalled()
    expect(agents.start).not.toHaveBeenCalled()
  })

  it('/mode attended starts without a worktree', async () => {
    const { deps, worktreeManager, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: '/mode attended\ndo the thing',
    })

    expect(result.ok).toBe(true)
    expect(worktreeManager.create).not.toHaveBeenCalled()
    const started = agents.start.mock.calls[0]?.[0]
    expect(started).toMatchObject({ executionMode: 'attended', approvalMode: 'safe-auto' })
    expect(started).not.toHaveProperty('worktreeId')
    expect(started).not.toHaveProperty('runId')
  })

  it('@mention starts a review run and returns kind review', async () => {
    const { deps, reviewer, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: '@claude review the last run',
    })

    expect(result).toEqual({
      ok: true,
      data: { taskId: TASK.id, kind: 'review', id: 'review-run-1' },
    })
    expect(reviewer.startReview).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      agentType: 'claude',
      taskId: TASK.id,
      prompt: 'review the last run',
    })
    expect(agents.start).not.toHaveBeenCalled()
  })

  it('@mention without a taskId creates the Task from the review text', async () => {
    const { deps, tasks, reviewer } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      workspaceId: WORKSPACE_ID,
      text: '@claude Review the login changes\nFocus on session handling',
    })

    expect(result).toEqual({
      ok: true,
      data: { taskId: 'task-new', kind: 'review', id: 'review-run-1' },
    })
    expect(tasks.create).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      title: 'Review the login changes',
      description: 'Focus on session handling',
    })
    expect(reviewer.startReview).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-new' }),
    )
  })

  it('/workflow full starts the default full workflow and returns kind workflow', async () => {
    const { deps, fullWorkflow, worktreeManager, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: '/agent claude\n/workflow full --test "npm run test:unit"',
    })

    expect(result).toEqual({ ok: true, data: { taskId: TASK.id, kind: 'workflow', id: 'wfrun-1' } })
    expect(fullWorkflow.start).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      taskId: TASK.id,
      implementer: 'claude',
      testCommand: 'npm run test:unit',
    })
    // The workflow builds its own worktree; the thread run path stays idle.
    expect(worktreeManager.create).not.toHaveBeenCalled()
    expect(agents.start).not.toHaveBeenCalled()
  })

  it('/workflow full without a taskId creates the Task from the body', async () => {
    const { deps, tasks, fullWorkflow } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      workspaceId: WORKSPACE_ID,
      text: '/workflow full\nImplement the login page',
    })

    expect(result).toEqual({
      ok: true,
      data: { taskId: 'task-new', kind: 'workflow', id: 'wfrun-1' },
    })
    expect(tasks.create).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      title: 'Implement the login page',
    })
    expect(fullWorkflow.start).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-new' }))
  })

  it('/workflow full without a taskId and without a body is refused', async () => {
    const { deps, tasks, fullWorkflow } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      workspaceId: WORKSPACE_ID,
      text: '/workflow full',
    })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        messageKey: 'errorMessage.messageDirectiveWorkflowNeedsTask',
      },
    })
    expect(tasks.create).not.toHaveBeenCalled()
    expect(fullWorkflow.start).not.toHaveBeenCalled()
  })

  it('a mixed @mention + / directives message is refused with the mention line', async () => {
    const { deps, reviewer, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: '/mode attended\n@claude review this',
    })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        messageKey: 'errorMessage.messageDirectiveMixedMention',
        params: { line: 2 },
      },
    })
    expect(reviewer.startReview).not.toHaveBeenCalled()
    expect(agents.start).not.toHaveBeenCalled()
  })

  it('propagates a reviewer start failure', async () => {
    const { deps, reviewer } = fakeDeps()
    reviewer.startReview.mockResolvedValue({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Agent "claude" is not registered.',
        retryable: false,
      },
    })
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: '@claude review this',
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })
})

/**
 * TASK-139 (Milestone 26 §9): the thread continuation branch. The task's most
 * recent exec Run decides — still running → CONFLICT with nothing created;
 * the four reuse conditions all met → a user-message Continuation; any miss →
 * a fresh round.
 */
describe('SendTaskMessageService continuation (TASK-139)', () => {
  /** A terminal exec Run matching DEFAULTS (agent codex / acct-1 / exec-1). */
  function sourceRun(overrides: Partial<AgentRun> = {}): AgentRun {
    return {
      id: 'run-prev',
      workspaceId: WORKSPACE_ID,
      taskId: TASK.id,
      agentType: 'codex',
      accountProfileId: 'acct-1',
      executionProfileId: 'exec-1',
      mode: 'exec',
      executionMode: 'orchestrated',
      approvalMode: 'safe-auto',
      status: 'completed',
      worktreeId: 'wt-prev',
      providerSession: { provider: 'codex', sessionId: 'sess-1' },
      runDir: '/data/runs/run-prev',
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
      ...overrides,
    }
  }

  function withSource(source: AgentRun | undefined, worktree: Worktree | null = WORKTREE) {
    const fixture = fakeDeps()
    fixture.runs.listByTask.mockReturnValue({
      ok: true,
      data: source === undefined ? [] : [source],
    })
    fixture.worktrees.getById.mockReturnValue({ ok: true, data: worktree })
    return fixture
  }

  it('all four conditions met → user-message Continuation, no fresh start and no new worktree', async () => {
    const fixture = withSource(sourceRun())
    const service = createSendTaskMessageService(fixture.deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: 'Now cover the edge case too',
    })

    expect(result).toEqual({
      ok: true,
      data: { taskId: TASK.id, kind: 'run', id: 'run-continued' },
    })
    expect(fixture.agents.continueWithProfile).toHaveBeenCalledWith({
      sourceRunId: 'run-prev',
      targetAgentId: 'codex',
      targetAccountProfileId: 'acct-1',
      targetExecutionProfileId: 'exec-1',
      reason: 'user-message',
      userMessage: 'Now cover the edge case too',
    })
    expect(fixture.agents.start).not.toHaveBeenCalled()
    expect(fixture.worktreeManager.create).not.toHaveBeenCalled()
  })

  it('a dirty worktree is still reusable', async () => {
    const fixture = withSource(sourceRun(), { ...WORKTREE, state: 'dirty' })
    const service = createSendTaskMessageService(fixture.deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: 'follow up',
    })

    expect(result.ok).toBe(true)
    expect(fixture.agents.continueWithProfile).toHaveBeenCalled()
    expect(fixture.agents.start).not.toHaveBeenCalled()
  })

  it.each(['running', 'preparing', 'queued'] as const)(
    'latest exec run %s → CONFLICT, nothing is created',
    async (status) => {
      const fixture = withSource(sourceRun({ status }))
      const service = createSendTaskMessageService(fixture.deps)

      const result = await service.sendMessage({
        taskId: TASK.id,
        workspaceId: WORKSPACE_ID,
        text: 'are you done yet?',
      })

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'CONFLICT', messageKey: 'errorMessage.threadRoundStillRunning' },
      })
      expect(fixture.agents.start).not.toHaveBeenCalled()
      expect(fixture.agents.continueWithProfile).not.toHaveBeenCalled()
      expect(fixture.worktreeManager.create).not.toHaveBeenCalled()
    },
  )

  it('condition 1 miss is impossible to bypass: only terminal runs continue', async () => {
    // covered by the CONFLICT cases above; here a terminal source continues.
    const fixture = withSource(sourceRun({ status: 'failed' }))
    const service = createSendTaskMessageService(fixture.deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: 'try again',
    })

    expect(result.ok).toBe(true)
    expect(fixture.agents.continueWithProfile).toHaveBeenCalled()
  })

  it('condition 2 counterexample: no providerSession → a fresh round starts', async () => {
    const fixture = withSource(sourceRun({ providerSession: undefined }))
    const service = createSendTaskMessageService(fixture.deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: 'follow up',
    })

    expect(result).toEqual({ ok: true, data: { taskId: TASK.id, kind: 'run', id: 'run-1' } })
    expect(fixture.agents.continueWithProfile).not.toHaveBeenCalled()
    expect(fixture.worktreeManager.create).toHaveBeenCalled()
    expect(fixture.agents.start).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK.id, prompt: 'follow up' }),
    )
  })

  it.each(['discarded', 'merged', 'missing', 'creating'] as const)(
    'condition 3 counterexample: worktree state %s → a fresh round starts',
    async (state) => {
      const fixture = withSource(sourceRun(), { ...WORKTREE, state })
      const service = createSendTaskMessageService(fixture.deps)

      const result = await service.sendMessage({
        taskId: TASK.id,
        workspaceId: WORKSPACE_ID,
        text: 'follow up',
      })

      expect(result).toEqual({ ok: true, data: { taskId: TASK.id, kind: 'run', id: 'run-1' } })
      expect(fixture.agents.continueWithProfile).not.toHaveBeenCalled()
      expect(fixture.worktreeManager.create).toHaveBeenCalled()
      expect(fixture.agents.start).toHaveBeenCalled()
    },
  )

  it('condition 3 counterexample: the worktree row is gone → a fresh round starts', async () => {
    const fixture = withSource(sourceRun(), null)
    const service = createSendTaskMessageService(fixture.deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: 'follow up',
    })

    expect(result).toEqual({ ok: true, data: { taskId: TASK.id, kind: 'run', id: 'run-1' } })
    expect(fixture.agents.continueWithProfile).not.toHaveBeenCalled()
    expect(fixture.agents.start).toHaveBeenCalled()
  })

  it('condition 3 counterexample: another non-terminal run occupies the worktree → a fresh round starts', async () => {
    const fixture = withSource(sourceRun())
    fixture.runs.listActive.mockReturnValue({
      ok: true,
      data: [sourceRun({ id: 'run-other', status: 'running' })],
    })
    const service = createSendTaskMessageService(fixture.deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: 'follow up',
    })

    expect(result).toEqual({ ok: true, data: { taskId: TASK.id, kind: 'run', id: 'run-1' } })
    expect(fixture.agents.continueWithProfile).not.toHaveBeenCalled()
    expect(fixture.agents.start).toHaveBeenCalled()
  })

  it('condition 4 counterexample: /agent changes the Agent → a fresh round starts', async () => {
    const fixture = withSource(sourceRun())
    const service = createSendTaskMessageService(fixture.deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: '/agent claude\nfollow up',
    })

    expect(result).toEqual({ ok: true, data: { taskId: TASK.id, kind: 'run', id: 'run-1' } })
    expect(fixture.agents.continueWithProfile).not.toHaveBeenCalled()
    expect(fixture.agents.start).toHaveBeenCalledWith(
      expect.objectContaining({ agentType: 'claude' }),
    )
  })

  it('condition 4 counterexample: an account override changes the account → a fresh round starts', async () => {
    const fixture = withSource(sourceRun())
    const service = createSendTaskMessageService(fixture.deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: 'follow up',
      overrides: { accountProfileId: 'acct-2' },
    })

    expect(result).toEqual({ ok: true, data: { taskId: TASK.id, kind: 'run', id: 'run-1' } })
    expect(fixture.agents.continueWithProfile).not.toHaveBeenCalled()
    expect(fixture.agents.start).toHaveBeenCalledWith(
      expect.objectContaining({ accountProfileId: 'acct-2' }),
    )
  })

  it('condition 4 counterexample: /mode attended changes the mode → a fresh attended round starts', async () => {
    const fixture = withSource(sourceRun())
    const service = createSendTaskMessageService(fixture.deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: '/mode attended\nfollow up',
    })

    expect(result).toEqual({ ok: true, data: { taskId: TASK.id, kind: 'run', id: 'run-1' } })
    expect(fixture.agents.continueWithProfile).not.toHaveBeenCalled()
    expect(fixture.worktreeManager.create).not.toHaveBeenCalled()
    expect(fixture.agents.start).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: 'attended' }),
    )
  })

  it('condition 4 counterexample: the resolved defaults drifted since the source started → a fresh round starts', async () => {
    const fixture = withSource(sourceRun())
    fixture.defaults.resolveDefaults.mockResolvedValue({
      ok: true,
      data: { ...DEFAULTS, accountProfileId: 'acct-9' },
    })
    const service = createSendTaskMessageService(fixture.deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: 'follow up',
    })

    expect(result).toEqual({ ok: true, data: { taskId: TASK.id, kind: 'run', id: 'run-1' } })
    expect(fixture.agents.continueWithProfile).not.toHaveBeenCalled()
    expect(fixture.agents.start).toHaveBeenCalled()
  })

  it('a newer interactive run does not block continuing the latest exec run', async () => {
    const fixture = withSource(sourceRun())
    fixture.runs.listByTask.mockReturnValue({
      ok: true,
      // listByTask is created_at DESC: the interactive run is newer.
      data: [
        sourceRun({ id: 'run-interactive', mode: 'interactive', status: 'running' }),
        sourceRun({ id: 'run-prev' }),
      ],
    })
    const service = createSendTaskMessageService(fixture.deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: 'follow up',
    })

    expect(result.ok).toBe(true)
    expect(fixture.agents.continueWithProfile).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRunId: 'run-prev' }),
    )
  })

  it('a continuation failure propagates without falling back to a fresh start', async () => {
    const fixture = withSource(sourceRun())
    fixture.agents.continueWithProfile.mockResolvedValue({
      ok: false,
      error: { code: 'UNKNOWN', message: 'resume failed', retryable: true },
    })
    const service = createSendTaskMessageService(fixture.deps)

    const result = await service.sendMessage({
      taskId: TASK.id,
      workspaceId: WORKSPACE_ID,
      text: 'follow up',
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
    expect(fixture.agents.start).not.toHaveBeenCalled()
  })
})
