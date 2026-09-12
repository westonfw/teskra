import type {
  FullWorkflowRunSummary,
  FullWorkflowStartResult,
  IpcResult,
  ListWorkflowRunsRequest,
  PublicAppError,
  StartFullWorkflowRequest,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunIdRequest,
  WorkbenchEvents,
} from '@teskra/contracts'
import { create } from 'zustand'
import { transportError } from '../i18n'

export interface WorkflowRunStoreBridge {
  readonly workflow: {
    listRuns(request?: ListWorkflowRunsRequest): Promise<IpcResult<WorkflowRun[]>>
    getRun(request: WorkflowRunIdRequest): Promise<IpcResult<WorkflowRunDetail | null>>
    startFullWorkflow(
      request: StartFullWorkflowRequest,
    ): Promise<IpcResult<FullWorkflowStartResult>>
    runSummary(request: WorkflowRunIdRequest): Promise<IpcResult<FullWorkflowRunSummary>>
  }
  readonly events: {
    subscribe<Name extends 'workflow.run_updated' | 'workflow.step_updated'>(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}

/**
 * WorkflowRunStore (TASK-063) — the Task page's view of workflow runs:
 * the run list of the selected Task, the selected run's per-step detail, and
 * its completion summary (worktree diff + criteria result). Subscribes to
 * workflow.run_updated / workflow.step_updated so every step's status tag and
 * the iteration counter refresh live; a terminal run loads its summary once
 * and refreshes it when a capped run resumes.
 */
interface WorkflowRunState {
  readonly taskId?: string
  readonly runs: readonly WorkflowRun[]
  readonly selectedId?: string
  readonly detail?: WorkflowRunDetail
  readonly summary?: FullWorkflowRunSummary
  readonly starting: boolean
  readonly loading: boolean
  readonly error?: PublicAppError
  /** Synchronizes the runs of one Task; refreshes on workflow events. */
  startSynchronization(taskId: string): () => void
  synchronize(taskId: string): Promise<void>
  /** Opens (or closes, with undefined) a run's step detail + summary. */
  selectRun(runId: string | undefined): Promise<void>
  /** One-click default full workflow launch; selects the new run. */
  startFullWorkflow(request: StartFullWorkflowRequest): Promise<FullWorkflowStartResult | undefined>
  clearError(): void
}

const SUMMARY_RUN_STATUSES = new Set(['needs_user_review', 'completed', 'failed', 'cancelled'])

export function createWorkflowRunStore(getBridge: () => WorkflowRunStoreBridge) {
  let synchronizationGeneration = 0
  let loadGeneration = 0
  let detailGeneration = 0

  return create<WorkflowRunState>((set, get) => {
    /** Refreshes the open run's detail, plus the summary once it can exist. */
    const refreshSelected = async (): Promise<void> => {
      const runId = get().selectedId
      if (runId === undefined) return
      const generation = ++detailGeneration
      try {
        const result = await getBridge().workflow.getRun({ runId })
        if (generation !== detailGeneration) return
        if (!result.ok) {
          set({ error: result.error })
          return
        }
        const detail = result.data ?? undefined
        set({ detail })
        if (detail !== undefined && SUMMARY_RUN_STATUSES.has(detail.run.status)) {
          const summary = await getBridge().workflow.runSummary({ runId })
          if (generation !== detailGeneration) return
          if (summary.ok) set({ summary: summary.data })
          else set({ error: summary.error })
        }
      } catch {
        if (generation === detailGeneration) set({ error: transportError() })
      }
    }

    return {
      runs: [],
      starting: false,
      loading: false,

      startSynchronization(taskId) {
        const generation = ++synchronizationGeneration
        if (get().taskId !== taskId) {
          set({ taskId, runs: [], selectedId: undefined, detail: undefined, summary: undefined })
        }
        const refresh = () => void get().synchronize(taskId)
        const refreshDetail = (runId: string) => {
          if (runId === get().selectedId) void refreshSelected()
        }
        const stops = [
          getBridge().events.subscribe('workflow.run_updated', (payload) => {
            refresh()
            refreshDetail(payload.runId)
          }),
          getBridge().events.subscribe('workflow.step_updated', (payload) => {
            refreshDetail(payload.runId)
          }),
        ]
        void get().synchronize(taskId)
        return () => {
          if (generation === synchronizationGeneration) synchronizationGeneration += 1
          for (const stop of stops) stop()
        }
      },

      async synchronize(taskId) {
        const generation = ++loadGeneration
        set({ taskId, loading: true, error: undefined })
        try {
          const result = await getBridge().workflow.listRuns({ taskId })
          if (generation !== loadGeneration) return
          if (!result.ok) {
            set({ loading: false, error: result.error })
            return
          }
          set({ runs: result.data, loading: false })
        } catch {
          if (generation === loadGeneration) set({ loading: false, error: transportError() })
        }
      },

      async selectRun(runId) {
        if (runId === undefined) {
          set({ selectedId: undefined, detail: undefined, summary: undefined })
          return
        }
        set({ selectedId: runId, detail: undefined, summary: undefined, error: undefined })
        await refreshSelected()
      },

      async startFullWorkflow(request) {
        set({ starting: true, error: undefined })
        try {
          const result = await getBridge().workflow.startFullWorkflow(request)
          if (!result.ok) {
            set({ starting: false, error: result.error })
            return undefined
          }
          set({ starting: false })
          await get().synchronize(request.taskId)
          await get().selectRun(result.data.run.id)
          return result.data
        } catch {
          set({ starting: false, error: transportError() })
          return undefined
        }
      },

      clearError() {
        set({ error: undefined })
      },
    }
  })
}

export const useWorkflowRunStore = createWorkflowRunStore(() => window.teskra)
