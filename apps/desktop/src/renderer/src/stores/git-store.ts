import type {
  DiffResult,
  GitStatus,
  IpcResult,
  PublicAppError,
  WorkbenchEvents,
} from '@teskra/contracts'
import { create } from 'zustand'

type GitRefreshEvent = 'git.changed' | 'agent.completed' | 'agent.failed' | 'agent.cancelled'

export interface GitStoreBridge {
  readonly git: {
    status(request: { workspaceId: string }): Promise<IpcResult<GitStatus>>
    changes(request: { workspaceId: string }): Promise<IpcResult<DiffResult>>
    openFile(request: { workspaceId: string; path: string }): Promise<IpcResult<void>>
  }
  readonly events: {
    subscribe<Name extends GitRefreshEvent>(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}

interface GitState {
  readonly status?: GitStatus
  readonly changes: DiffResult
  readonly selectedPath?: string
  readonly loading: boolean
  readonly error?: PublicAppError
  startSynchronization(workspaceId: string): () => void
  refresh(workspaceId: string): Promise<void>
  selectFile(path?: string): void
  openFile(workspaceId: string, path: string): Promise<boolean>
  clearError(): void
}

const transportError: PublicAppError = {
  code: 'UNKNOWN',
  message: 'Teskra could not reach the Git service.',
  retryable: true,
}

export function createGitStore(getBridge: () => GitStoreBridge) {
  let synchronizationGeneration = 0
  let refreshGeneration = 0

  return create<GitState>((set, get) => ({
    changes: { files: [] },
    loading: false,

    startSynchronization(workspaceId) {
      const generation = ++synchronizationGeneration
      const bridge = getBridge()
      const refresh = (): void => {
        if (generation === synchronizationGeneration) void get().refresh(workspaceId)
      }
      const refreshWorkspace = ({ workspaceId: changedWorkspaceId }: { workspaceId: string }) => {
        if (changedWorkspaceId === workspaceId) refresh()
      }
      const stops = [
        bridge.events.subscribe('git.changed', refreshWorkspace),
        bridge.events.subscribe('agent.completed', refresh),
        bridge.events.subscribe('agent.failed', refresh),
        bridge.events.subscribe('agent.cancelled', refresh),
      ]
      void get().refresh(workspaceId)
      return () => {
        if (generation === synchronizationGeneration) synchronizationGeneration += 1
        for (const stop of stops) stop()
      }
    },

    async refresh(workspaceId) {
      const generation = ++refreshGeneration
      set({ loading: true, error: undefined })
      try {
        const bridge = getBridge()
        const [status, changes] = await Promise.all([
          bridge.git.status({ workspaceId }),
          bridge.git.changes({ workspaceId }),
        ])
        if (generation !== refreshGeneration) return
        if (!status.ok) {
          set({ loading: false, error: status.error })
          return
        }
        if (!changes.ok) {
          set({ loading: false, error: changes.error })
          return
        }
        set((state) => ({
          status: status.data,
          changes: changes.data,
          selectedPath:
            changes.data.files.find(({ path }) => path === state.selectedPath)?.path ??
            changes.data.files[0]?.path,
          loading: false,
        }))
      } catch {
        if (generation === refreshGeneration) set({ loading: false, error: transportError })
      }
    },

    selectFile(path) {
      set({ selectedPath: path })
    },

    async openFile(workspaceId, path) {
      set({ error: undefined })
      try {
        const result = await getBridge().git.openFile({ workspaceId, path })
        if (!result.ok) {
          set({ error: result.error })
          return false
        }
        return true
      } catch {
        set({ error: transportError })
        return false
      }
    },

    clearError() {
      set({ error: undefined })
    },
  }))
}

export const useGitStore = createGitStore(() => window.teskra)
