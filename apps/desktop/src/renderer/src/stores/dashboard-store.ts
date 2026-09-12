import type {
  AgentHealth,
  AgentRun,
  IpcResult,
  ListAgentDetectionsRequest,
  ListAgentRunsRequest,
  ListTasksRequest,
  ListWorkflowRunsRequest,
  PublicAppError,
  Task,
  WorkbenchEvents,
  WorkflowRun,
  Workspace,
  Worktree,
  WorktreeListRequest,
} from '@teskra/contracts'
import { create } from 'zustand'
import { transportError } from '../i18n'

/** TASK-071: how many entries each dashboard block previews before "view all". */
export const DASHBOARD_PREVIEW_LIMIT = 5

export const DASHBOARD_BLOCK_KEYS = [
  'activeTasks',
  'waitingForYou',
  'interruptedRuns',
  'mergeReady',
  'agentAvailability',
  'recentFailures',
] as const
export type DashboardBlockKey = (typeof DASHBOARD_BLOCK_KEYS)[number]

export type DashboardBlockStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface DashboardBlock<T> {
  readonly status: DashboardBlockStatus
  readonly data?: T
  readonly error?: PublicAppError
}

export interface DashboardListSummary<T> {
  readonly total: number
  readonly items: readonly T[]
}

export interface WaitingForYouSummary {
  readonly total: number
  readonly tasks: readonly Task[]
  readonly workflowRuns: readonly WorkflowRun[]
}

export interface DashboardStoreBridge {
  readonly task: {
    list(request: ListTasksRequest): Promise<IpcResult<Task[]>>
  }
  readonly agent: {
    list(request: ListAgentRunsRequest): Promise<IpcResult<AgentRun[]>>
    listHealth(request: ListAgentDetectionsRequest): Promise<IpcResult<AgentHealth[]>>
  }
  readonly worktree: {
    list(request: WorktreeListRequest): Promise<IpcResult<Worktree[]>>
  }
  readonly workflow: {
    listRuns(request?: ListWorkflowRunsRequest): Promise<IpcResult<WorkflowRun[]>>
  }
  readonly events: {
    subscribe<
      Name extends
        | 'task.created'
        | 'task.updated'
        | 'agent.started'
        | 'agent.waiting'
        | 'agent.completed'
        | 'agent.failed'
        | 'agent.cancelled'
        | 'agent.interrupted'
        | 'workflow.run_updated'
        | 'worktree.merged'
        | 'worktree.merge_conflict'
        | 'git.changed',
    >(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}

interface DashboardState {
  readonly activeTasks: DashboardBlock<DashboardListSummary<Task>>
  readonly waitingForYou: DashboardBlock<WaitingForYouSummary>
  readonly interruptedRuns: DashboardBlock<DashboardListSummary<AgentRun>>
  readonly mergeReady: DashboardBlock<DashboardListSummary<Worktree>>
  readonly agentAvailability: DashboardBlock<readonly AgentHealth[]>
  readonly recentFailures: DashboardBlock<DashboardListSummary<AgentRun>>
  /** Fires every block loader in parallel; each block settles independently. */
  load(workspace: Workspace): void
  reloadBlock(workspace: Workspace, block: DashboardBlockKey): void
  startSynchronization(workspace: Workspace): () => void
}

const idle = <T>(): DashboardBlock<T> => ({ status: 'idle' })

const byUpdatedAtDesc = <T extends { readonly updatedAt: string }>(left: T, right: T): number =>
  right.updatedAt.localeCompare(left.updatedAt)

const failureSortKey = (run: AgentRun): string => run.finishedAt ?? run.updatedAt

function summarize<T>(items: readonly T[]): DashboardListSummary<T> {
  return { total: items.length, items: items.slice(0, DASHBOARD_PREVIEW_LIMIT) }
}

/**
 * TASK-071 Home Dashboard: aggregates the six overview blocks from the existing
 * typed IPC surface. Every block loads independently so one failing source
 * never drags down the rest of the page. Merge Ready intentionally lists
 * `ready` worktrees only — running a full merge preflight per worktree on the
 * dashboard would be too expensive.
 */
export function createDashboardStore(getBridge: () => DashboardStoreBridge) {
  const generations: Record<DashboardBlockKey, number> = {
    activeTasks: 0,
    waitingForYou: 0,
    interruptedRuns: 0,
    mergeReady: 0,
    agentAvailability: 0,
    recentFailures: 0,
  }
  let synchronizationGeneration = 0

  return create<DashboardState>((set) => {
    const patch = (block: DashboardBlockKey, value: DashboardBlock<unknown>): void => {
      set({ [block]: value } as Partial<DashboardState>)
    }
    const begin = (block: DashboardBlockKey): number => {
      const generation = ++generations[block]
      set((state) => ({ [block]: { status: 'loading', data: state[block].data } }))
      return generation
    }
    const succeed = (block: DashboardBlockKey, generation: number, data: unknown): void => {
      if (generation !== generations[block]) return
      patch(block, { status: 'ready', data })
    }
    const fail = (block: DashboardBlockKey, generation: number, error: PublicAppError): void => {
      if (generation !== generations[block]) return
      set((state) => ({
        [block]: { status: 'error', data: state[block].data, error },
      }))
    }

    const loadActiveTasks = async (workspaceId: string): Promise<void> => {
      const generation = begin('activeTasks')
      try {
        const result = await getBridge().task.list({ workspaceId, status: 'running' })
        if (!result.ok) {
          fail('activeTasks', generation, result.error)
          return
        }
        succeed('activeTasks', generation, summarize([...result.data].sort(byUpdatedAtDesc)))
      } catch {
        fail('activeTasks', generation, transportError())
      }
    }

    const loadWaitingForYou = async (workspaceId: string): Promise<void> => {
      const generation = begin('waitingForYou')
      try {
        const [tasksResult, workflowResult] = await Promise.all([
          getBridge().task.list({ workspaceId }),
          getBridge().workflow.listRuns({ status: 'needs_user_review' }),
        ])
        if (!tasksResult.ok) {
          fail('waitingForYou', generation, tasksResult.error)
          return
        }
        if (!workflowResult.ok) {
          fail('waitingForYou', generation, workflowResult.error)
          return
        }
        const tasks = tasksResult.data
          .filter((task) => task.status === 'needs_review')
          .sort(byUpdatedAtDesc)
        // Workflow runs carry no workspaceId (ADR-0006 task is optional), so
        // they are scoped through their task; task-less runs cannot be
        // attributed and are left out.
        const taskIds = new Set(tasksResult.data.map((task) => task.id))
        const workflowRuns = workflowResult.data.filter(
          (run) => run.taskId !== undefined && taskIds.has(run.taskId),
        )
        succeed('waitingForYou', generation, {
          total: tasks.length + workflowRuns.length,
          tasks: tasks.slice(0, DASHBOARD_PREVIEW_LIMIT),
          workflowRuns: workflowRuns.slice(0, DASHBOARD_PREVIEW_LIMIT),
        } satisfies WaitingForYouSummary)
      } catch {
        fail('waitingForYou', generation, transportError())
      }
    }

    const loadInterruptedRuns = async (workspaceId: string): Promise<void> => {
      const generation = begin('interruptedRuns')
      try {
        const result = await getBridge().agent.list({ workspaceId })
        if (!result.ok) {
          fail('interruptedRuns', generation, result.error)
          return
        }
        const runs = result.data
          .filter(({ status }) => status === 'interrupted')
          .sort(byUpdatedAtDesc)
        succeed('interruptedRuns', generation, summarize(runs))
      } catch {
        fail('interruptedRuns', generation, transportError())
      }
    }

    const loadMergeReady = async (workspaceId: string): Promise<void> => {
      const generation = begin('mergeReady')
      try {
        const result = await getBridge().worktree.list({ workspaceId })
        if (!result.ok) {
          fail('mergeReady', generation, result.error)
          return
        }
        const worktrees = result.data.filter(({ state }) => state === 'ready').sort(byUpdatedAtDesc)
        succeed('mergeReady', generation, summarize(worktrees))
      } catch {
        fail('mergeReady', generation, transportError())
      }
    }

    const loadAgentAvailability = async (workspace: Workspace): Promise<void> => {
      const generation = begin('agentAvailability')
      try {
        const result = await getBridge().agent.listHealth({
          runtime: workspace.runtime,
          refresh: true,
        })
        if (!result.ok) {
          fail('agentAvailability', generation, result.error)
          return
        }
        succeed('agentAvailability', generation, result.data)
      } catch {
        fail('agentAvailability', generation, transportError())
      }
    }

    const loadRecentFailures = async (workspaceId: string): Promise<void> => {
      const generation = begin('recentFailures')
      try {
        const result = await getBridge().agent.list({ workspaceId })
        if (!result.ok) {
          fail('recentFailures', generation, result.error)
          return
        }
        const runs = result.data
          .filter(({ status }) => status === 'failed')
          .sort((left, right) => failureSortKey(right).localeCompare(failureSortKey(left)))
        succeed('recentFailures', generation, summarize(runs))
      } catch {
        fail('recentFailures', generation, transportError())
      }
    }

    const loaders: Record<DashboardBlockKey, (workspace: Workspace) => Promise<void>> = {
      activeTasks: (workspace) => loadActiveTasks(workspace.id),
      waitingForYou: (workspace) => loadWaitingForYou(workspace.id),
      interruptedRuns: (workspace) => loadInterruptedRuns(workspace.id),
      mergeReady: (workspace) => loadMergeReady(workspace.id),
      agentAvailability: loadAgentAvailability,
      recentFailures: (workspace) => loadRecentFailures(workspace.id),
    }

    const loadAll = (workspace: Workspace): void => {
      for (const key of DASHBOARD_BLOCK_KEYS) void loaders[key](workspace)
    }

    return {
      activeTasks: idle(),
      waitingForYou: idle(),
      interruptedRuns: idle(),
      mergeReady: idle(),
      agentAvailability: idle(),
      recentFailures: idle(),

      load: loadAll,

      reloadBlock(workspace, block) {
        void loaders[block](workspace)
      },

      startSynchronization(workspace) {
        const generation = ++synchronizationGeneration
        const reload = (): void => {
          if (generation !== synchronizationGeneration) return
          loadAll(workspace)
        }
        const stops = [
          getBridge().events.subscribe('task.created', reload),
          getBridge().events.subscribe('task.updated', reload),
          getBridge().events.subscribe('agent.started', reload),
          getBridge().events.subscribe('agent.waiting', reload),
          getBridge().events.subscribe('agent.completed', reload),
          getBridge().events.subscribe('agent.failed', reload),
          getBridge().events.subscribe('agent.cancelled', reload),
          getBridge().events.subscribe('agent.interrupted', reload),
          getBridge().events.subscribe('workflow.run_updated', reload),
          getBridge().events.subscribe('worktree.merged', reload),
          getBridge().events.subscribe('worktree.merge_conflict', reload),
          getBridge().events.subscribe('git.changed', reload),
        ]
        loadAll(workspace)

        return () => {
          if (generation === synchronizationGeneration) synchronizationGeneration += 1
          for (const stop of stops) stop()
        }
      },
    }
  })
}

export const useDashboardStore = createDashboardStore(() => window.teskra)
