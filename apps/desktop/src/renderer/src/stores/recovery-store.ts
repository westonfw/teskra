import type {
  AgentRun,
  IpcResult,
  ListRecoveryIssuesRequest,
  PublicAppError,
  RecoveryIssue,
  RecoveryReport,
  ResumeAgentRunRequest,
  WorkbenchEvents,
  Worktree,
  WorktreeDiscardRequest,
  WorktreeIdRequest,
} from '@teskra/contracts'
import { create } from 'zustand'
import { transportError } from '../i18n'

export interface RecoveryStoreBridge {
  readonly recovery: {
    list(request?: ListRecoveryIssuesRequest): Promise<IpcResult<RecoveryReport>>
  }
  readonly agent: {
    resume(request: ResumeAgentRunRequest): Promise<IpcResult<AgentRun>>
  }
  readonly worktree: {
    validate(request: WorktreeIdRequest): Promise<IpcResult<Worktree>>
    discard(request: WorktreeDiscardRequest): Promise<IpcResult<Worktree>>
  }
  readonly events: {
    subscribe<
      Name extends
        | 'agent.started'
        | 'agent.completed'
        | 'agent.failed'
        | 'agent.cancelled'
        | 'agent.interrupted'
        | 'agent.committed'
        | 'git.changed'
        | 'worktree.merge_conflict'
        | 'worktree.merged',
    >(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}

interface RecoveryState {
  readonly issues: readonly RecoveryIssue[]
  readonly generatedAt?: string
  readonly loading: boolean
  readonly acting: Readonly<Record<string, boolean | undefined>>
  readonly error?: PublicAppError
  load(workspaceId: string): Promise<void>
  resumeRun(workspaceId: string, runId: string): Promise<boolean>
  repairWorktree(workspaceId: string, worktreeId: string): Promise<boolean>
  discardWorktree(workspaceId: string, worktreeId: string): Promise<boolean>
  startSynchronization(workspaceId: string): () => void
  clearError(): void
}

export function createRecoveryStore(getBridge: () => RecoveryStoreBridge) {
  let loadGeneration = 0
  let synchronizationGeneration = 0

  return create<RecoveryState>((set, get) => ({
    issues: [],
    loading: false,
    acting: {},

    async load(workspaceId) {
      const generation = ++loadGeneration
      set({ loading: true, error: undefined })
      try {
        const result = await getBridge().recovery.list({ workspaceId })
        if (generation !== loadGeneration) return
        if (!result.ok) {
          set({ loading: false, error: result.error })
          return
        }
        set({ issues: result.data.issues, generatedAt: result.data.generatedAt, loading: false })
      } catch {
        if (generation === loadGeneration) set({ loading: false, error: transportError() })
      }
    },

    async resumeRun(workspaceId, runId) {
      set((state) => ({ acting: { ...state.acting, [runId]: true }, error: undefined }))
      try {
        const result = await getBridge().agent.resume({ runId })
        if (!result.ok) {
          set({ error: result.error })
          return false
        }
        await get().load(workspaceId)
        return true
      } catch {
        set({ error: transportError() })
        return false
      } finally {
        set((state) => ({ acting: { ...state.acting, [runId]: false } }))
      }
    },

    async repairWorktree(workspaceId, worktreeId) {
      set((state) => ({ acting: { ...state.acting, [worktreeId]: true }, error: undefined }))
      try {
        const result = await getBridge().worktree.validate({ worktreeId })
        if (!result.ok) {
          set({ error: result.error })
          return false
        }
        await get().load(workspaceId)
        return true
      } catch {
        set({ error: transportError() })
        return false
      } finally {
        set((state) => ({ acting: { ...state.acting, [worktreeId]: false } }))
      }
    },

    async discardWorktree(workspaceId, worktreeId) {
      set((state) => ({ acting: { ...state.acting, [worktreeId]: true }, error: undefined }))
      try {
        const result = await getBridge().worktree.discard({ worktreeId, confirm: true })
        if (!result.ok) {
          set({ error: result.error })
          return false
        }
        await get().load(workspaceId)
        return true
      } catch {
        set({ error: transportError() })
        return false
      } finally {
        set((state) => ({ acting: { ...state.acting, [worktreeId]: false } }))
      }
    },

    startSynchronization(workspaceId) {
      const generation = ++synchronizationGeneration
      const reload = (): void => {
        if (generation !== synchronizationGeneration) return
        void get().load(workspaceId)
      }
      const stops = [
        getBridge().events.subscribe('agent.started', reload),
        getBridge().events.subscribe('agent.completed', reload),
        getBridge().events.subscribe('agent.failed', reload),
        getBridge().events.subscribe('agent.cancelled', reload),
        getBridge().events.subscribe('agent.interrupted', reload),
        getBridge().events.subscribe('agent.committed', reload),
        getBridge().events.subscribe('git.changed', reload),
        getBridge().events.subscribe('worktree.merge_conflict', reload),
        getBridge().events.subscribe('worktree.merged', reload),
      ]
      void get().load(workspaceId)

      return () => {
        if (generation === synchronizationGeneration) synchronizationGeneration += 1
        for (const stop of stops) stop()
      }
    },

    clearError() {
      set({ error: undefined })
    },
  }))
}

export const useRecoveryStore = createRecoveryStore(() => window.teskra)
