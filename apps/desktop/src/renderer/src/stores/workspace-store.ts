import type {
  IpcResult,
  OpenWorkspaceRequest,
  PublicAppError,
  UpdateWorkspaceTrustRequest,
  Workspace,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'
import { create } from 'zustand'
import { transportError } from '../i18n'

export interface WorkspaceStoreBridge {
  readonly workspace: {
    open(request: OpenWorkspaceRequest): Promise<IpcResult<Workspace>>
    remove(request: { id: string }): Promise<IpcResult<boolean>>
    listRecent(request?: { limit?: number }): Promise<IpcResult<Workspace[]>>
    selectDirectory(request: { runtime: WorkspaceRuntimeRef }): Promise<IpcResult<string | null>>
    updateTrust(request: UpdateWorkspaceTrustRequest): Promise<IpcResult<Workspace>>
  }
}

interface WorkspaceState {
  readonly recent: readonly Workspace[]
  readonly current?: Workspace | undefined
  readonly loading: boolean
  readonly error?: PublicAppError | undefined
  loadRecent(): Promise<void>
  openWorkspace(request: OpenWorkspaceRequest): Promise<Workspace | undefined>
  removeWorkspace(id: string): Promise<boolean>
  selectWorkspace(id: string): void
  selectDirectory(runtime: WorkspaceRuntimeRef): Promise<string | null>
  /** TASK-118: flips the workspace trust level and refreshes it in the list. */
  setTrustLevel(id: string, trustLevel: Workspace['trustLevel']): Promise<boolean>
  clearError(): void
}

export function createWorkspaceStore(getBridge: () => WorkspaceStoreBridge) {
  return create<WorkspaceState>((set, get) => ({
    recent: [],
    loading: false,

    async loadRecent() {
      set({ loading: true, error: undefined })
      try {
        const result = await getBridge().workspace.listRecent({ limit: 30 })
        if (!result.ok) {
          set({ loading: false, error: result.error })
          return
        }
        set((state) => ({
          recent: result.data,
          current:
            result.data.find((workspace) => workspace.id === state.current?.id) ??
            state.current ??
            result.data[0],
          loading: false,
        }))
      } catch {
        set({ loading: false, error: transportError() })
      }
    },

    async openWorkspace(request) {
      set({ loading: true, error: undefined })
      try {
        const result = await getBridge().workspace.open(request)
        if (!result.ok) {
          set({ loading: false, error: result.error })
          return undefined
        }
        set((state) => ({
          current: result.data,
          recent: [result.data, ...state.recent.filter(({ id }) => id !== result.data.id)],
          loading: false,
        }))
        return result.data
      } catch {
        set({ loading: false, error: transportError() })
        return undefined
      }
    },

    async removeWorkspace(id) {
      set({ error: undefined })
      try {
        const result = await getBridge().workspace.remove({ id })
        if (!result.ok) {
          set({ error: result.error })
          return false
        }
        set((state) => {
          const recent = state.recent.filter((workspace) => workspace.id !== id)
          return {
            recent,
            current: state.current?.id === id ? recent[0] : state.current,
          }
        })
        return result.data
      } catch {
        set({ error: transportError() })
        return false
      }
    },

    selectWorkspace(id) {
      const workspace = get().recent.find((candidate) => candidate.id === id)
      if (workspace !== undefined) set({ current: workspace })
    },

    async selectDirectory(runtime) {
      set({ error: undefined })
      try {
        const result = await getBridge().workspace.selectDirectory({ runtime })
        if (!result.ok) {
          set({ error: result.error })
          return null
        }
        return result.data
      } catch {
        set({ error: transportError() })
        return null
      }
    },

    async setTrustLevel(id, trustLevel) {
      set({ error: undefined })
      try {
        const result = await getBridge().workspace.updateTrust({ id, trustLevel })
        if (!result.ok) {
          set({ error: result.error })
          return false
        }
        set((state) => ({
          recent: state.recent.map((workspace) => (workspace.id === id ? result.data : workspace)),
          current: state.current?.id === id ? result.data : state.current,
        }))
        return true
      } catch {
        set({ error: transportError() })
        return false
      }
    },

    clearError() {
      set({ error: undefined })
    },
  }))
}

export const useWorkspaceStore = createWorkspaceStore(() => window.teskra)
