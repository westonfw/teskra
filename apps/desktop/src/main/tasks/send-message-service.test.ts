import { describe, expect, it, vi } from 'vitest'

import {
  IPC_NAME_MAX,
  type AgentRun,
  type IpcResult,
  type ResolvedRunDefaults,
  type StartAgentRunRequest,
  type Task,
  type Worktree,
} from '@teskra/contracts'

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
  }
  return {
    deps: {
      tasks,
      defaults,
      worktreeManager,
      agents,
      createAgentRunId: () => 'run-1',
      ...overrides,
    } satisfies SendTaskMessageServiceDeps,
    tasks,
    defaults,
    worktreeManager,
    agents,
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

  it('refuses an empty first line without creating anything', async () => {
    const { deps, tasks, worktreeManager, agents } = fakeDeps()
    const service = createSendTaskMessageService(deps)

    const result = await service.sendMessage({
      workspaceId: WORKSPACE_ID,
      text: '\n\nonly details',
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(tasks.create).not.toHaveBeenCalled()
    expect(worktreeManager.create).not.toHaveBeenCalled()
    expect(agents.start).not.toHaveBeenCalled()
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
