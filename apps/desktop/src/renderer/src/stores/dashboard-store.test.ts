import type {
  AgentHealth,
  AgentRun,
  IpcResult,
  ListTasksRequest,
  Task,
  WorkbenchEventName,
  WorkbenchEvents,
  WorkflowRun,
  Workspace,
  Worktree,
} from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import {
  createDashboardStore,
  DASHBOARD_PREVIEW_LIMIT,
  type DashboardStoreBridge,
} from './dashboard-store'

const WORKSPACE_ID = 'workspace-1'

const workspace: Workspace = {
  id: WORKSPACE_ID,
  name: 'Teskra',
  path: '/repos/teskra',
  defaultBranch: 'main',
  runtime: { kind: 'windows' },
  trustLevel: 'trusted',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    workspaceId: WORKSPACE_ID,
    title: 'Implement TASK-071',
    status: 'running',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T01:00:00.000Z',
    ...overrides,
  }
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    workspaceId: WORKSPACE_ID,
    agentType: 'codex',
    status: 'failed',
    executionMode: 'attended',
    runDir: '/data/runs/run-1',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T01:00:00.000Z',
    ...overrides,
  }
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    workspaceId: WORKSPACE_ID,
    branch: 'agent/task-1/codex/run-1',
    baseBranch: 'main',
    path: '/data/worktrees/ws/run-1',
    state: 'ready',
    isolation: 'worktree',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T01:00:00.000Z',
    ...overrides,
  }
}

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'wfr-1',
    taskId: 'task-2',
    workflowDefinitionId: 'implement-review',
    definition: { id: 'implement-review', steps: [] },
    status: 'needs_user_review',
    currentIteration: 1,
    totalIterations: 3,
    criteriaIteration: 1,
    createdAt: '2026-09-10T00:30:00.000Z',
    ...overrides,
  }
}

function health(overrides: Partial<AgentHealth> = {}): AgentHealth {
  return {
    agentId: 'codex',
    runtime: { kind: 'windows' },
    installed: true,
    available: true,
    checkedAt: '2026-09-10T01:00:00.000Z',
    ...overrides,
  }
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function createBridge() {
  const handlers = new Map<WorkbenchEventName, Set<(payload: never) => void>>()
  const bridge: DashboardStoreBridge = {
    task: {
      list: vi.fn(async (request: ListTasksRequest) => {
        const all = [
          task({ id: 'task-1', status: 'running' }),
          task({ id: 'task-2', status: 'needs_review', title: 'Review me' }),
          task({ id: 'task-3', status: 'completed' }),
        ]
        return ok(
          request.status === undefined
            ? all
            : all.filter(({ status }) => status === request.status),
        )
      }),
    },
    agent: {
      list: vi.fn(async () =>
        ok([
          run({ id: 'run-interrupted', status: 'interrupted' }),
          run({ id: 'run-failed-old', status: 'failed', finishedAt: '2026-09-09T10:00:00.000Z' }),
          run({ id: 'run-failed-new', status: 'failed', finishedAt: '2026-09-10T00:30:00.000Z' }),
          run({ id: 'run-running', status: 'running' }),
        ]),
      ),
      listHealth: vi.fn(async () =>
        ok([
          health({ agentId: 'codex', available: true }),
          health({ agentId: 'claude-code', available: false, installed: false }),
        ]),
      ),
    },
    worktree: {
      list: vi.fn(async () =>
        ok([
          worktree({ id: 'wt-1', state: 'ready' }),
          worktree({ id: 'wt-2', state: 'dirty' }),
          worktree({ id: 'wt-3', state: 'merged' }),
        ]),
      ),
    },
    workflow: {
      listRuns: vi.fn(async () =>
        ok([
          workflowRun({ id: 'wfr-1', taskId: 'task-2' }),
          workflowRun({ id: 'wfr-other-workspace', taskId: 'task-elsewhere' }),
          workflowRun({ id: 'wfr-taskless', taskId: undefined }),
        ]),
      ),
    },
    events: {
      subscribe: vi.fn((name: WorkbenchEventName, handler: (payload: never) => void) => {
        let listeners = handlers.get(name)
        if (listeners === undefined) {
          listeners = new Set()
          handlers.set(name, listeners)
        }
        listeners.add(handler)
        return () => listeners?.delete(handler)
      }),
    },
  }
  const emit = <Name extends WorkbenchEventName>(name: Name, payload: WorkbenchEvents[Name]) => {
    for (const handler of handlers.get(name) ?? []) handler(payload as never)
  }
  return { bridge, emit }
}

describe('dashboard store (TASK-071)', () => {
  it('loads all six blocks from the bridge', async () => {
    const { bridge } = createBridge()
    const store = createDashboardStore(() => bridge)

    store.getState().load(workspace)
    await vi.waitFor(() => {
      const state = store.getState()
      for (const block of [
        state.activeTasks,
        state.waitingForYou,
        state.interruptedRuns,
        state.mergeReady,
        state.agentAvailability,
        state.recentFailures,
      ]) {
        expect(block.status).toBe('ready')
      }
    })

    const state = store.getState()
    expect(state.activeTasks.data?.total).toBe(1)
    expect(state.activeTasks.data?.items[0]?.id).toBe('task-1')

    expect(state.waitingForYou.data?.total).toBe(2)
    expect(state.waitingForYou.data?.tasks.map(({ id }) => id)).toEqual(['task-2'])
    // Scoped through the workspace's tasks: other-workspace and task-less runs excluded.
    expect(state.waitingForYou.data?.workflowRuns.map(({ id }) => id)).toEqual(['wfr-1'])

    expect(state.interruptedRuns.data?.total).toBe(1)
    expect(state.interruptedRuns.data?.items[0]?.id).toBe('run-interrupted')

    expect(state.mergeReady.data?.total).toBe(1)
    expect(state.mergeReady.data?.items[0]?.id).toBe('wt-1')

    expect(state.agentAvailability.data?.map(({ agentId }) => agentId)).toEqual([
      'codex',
      'claude-code',
    ])

    // Most recent failure first.
    expect(state.recentFailures.data?.total).toBe(2)
    expect(state.recentFailures.data?.items.map(({ id }) => id)).toEqual([
      'run-failed-new',
      'run-failed-old',
    ])

    expect(bridge.task.list).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, status: 'running' })
    expect(bridge.agent.listHealth).toHaveBeenCalledWith({
      runtime: workspace.runtime,
      refresh: true,
    })
  })

  it('keeps other blocks ready when one block fails', async () => {
    const { bridge } = createBridge()
    bridge.worktree.list = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'CAPABILITY_NOT_AVAILABLE' as const,
        message: 'Git is not available.',
        retryable: true,
      },
    }))
    const store = createDashboardStore(() => bridge)

    store.getState().load(workspace)
    await vi.waitFor(() => expect(store.getState().mergeReady.status).toBe('error'))

    const state = store.getState()
    expect(state.mergeReady.error?.message).toBe('Git is not available.')
    expect(state.activeTasks.status).toBe('ready')
    expect(state.waitingForYou.status).toBe('ready')
    expect(state.interruptedRuns.status).toBe('ready')
    expect(state.agentAvailability.status).toBe('ready')
    expect(state.recentFailures.status).toBe('ready')
  })

  it('turns a thrown bridge call into a block-level transport error', async () => {
    const { bridge } = createBridge()
    bridge.agent.listHealth = vi.fn(async () => {
      throw new Error('ipc gone')
    })
    const store = createDashboardStore(() => bridge)

    store.getState().load(workspace)
    await vi.waitFor(() => expect(store.getState().agentAvailability.status).toBe('error'))

    expect(store.getState().agentAvailability.error?.code).toBe('UNKNOWN')
    expect(store.getState().activeTasks.status).toBe('ready')
  })

  it('caps block previews at the dashboard limit', async () => {
    const { bridge } = createBridge()
    bridge.task.list = vi.fn(async () =>
      ok(
        Array.from({ length: DASHBOARD_PREVIEW_LIMIT + 2 }, (_, index) =>
          task({
            id: `task-${String(index)}`,
            status: 'running',
            updatedAt: `2026-09-10T0${String(index)}:00:00.000Z`,
          }),
        ),
      ),
    )
    const store = createDashboardStore(() => bridge)

    store.getState().load(workspace)
    await vi.waitFor(() => expect(store.getState().activeTasks.status).toBe('ready'))

    expect(store.getState().activeTasks.data?.total).toBe(DASHBOARD_PREVIEW_LIMIT + 2)
    expect(store.getState().activeTasks.data?.items).toHaveLength(DASHBOARD_PREVIEW_LIMIT)
  })

  it('reloads only the requested block', async () => {
    const { bridge } = createBridge()
    const store = createDashboardStore(() => bridge)

    store.getState().reloadBlock(workspace, 'mergeReady')
    await vi.waitFor(() => expect(store.getState().mergeReady.status).toBe('ready'))

    expect(bridge.worktree.list).toHaveBeenCalledTimes(1)
    expect(bridge.task.list).not.toHaveBeenCalled()
    expect(bridge.agent.list).not.toHaveBeenCalled()
    expect(store.getState().activeTasks.status).toBe('idle')
  })

  it('reloads on workbench events and stops after unsubscribe', async () => {
    const { bridge, emit } = createBridge()
    const store = createDashboardStore(() => bridge)
    const stop = store.getState().startSynchronization(workspace)
    await vi.waitFor(() => expect(bridge.task.list).toHaveBeenCalledTimes(2))

    emit('task.updated', { taskId: 'task-1' })
    emit('workflow.run_updated', { runId: 'wfr-1', status: 'needs_user_review' })
    await vi.waitFor(() => expect(bridge.task.list).toHaveBeenCalledTimes(6))

    stop()
    emit('git.changed', { workspaceId: WORKSPACE_ID })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bridge.task.list).toHaveBeenCalledTimes(6)
  })
})
