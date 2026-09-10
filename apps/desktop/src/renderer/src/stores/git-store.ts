import type {
  DiffResult,
  GitStatus,
  IpcResult,
  PublicAppError,
  WorkbenchEvents,
} from '@teskra/contracts'
import { create } from 'zustand'

type GitRefreshEvent =
  | 'git.changed'
  | 'agent.created'
  | 'agent.queued'
  | 'agent.started'
  | 'agent.output'
  | 'agent.waiting'
  | 'agent.completed'
  | 'agent.failed'
  | 'agent.cancelled'
  | 'agent.interrupted'

export const GIT_OUTPUT_DEBOUNCE_MS = 1_500
export const GIT_FOCUS_THROTTLE_MS = 5_000

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
  refreshOnFocus(workspaceId: string): void
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
  const refreshInFlight = new Map<string, Promise<void>>()
  const lastFocusRefreshAt = new Map<string, number>()

  return create<GitState>((set, get) => ({
    changes: { files: [] },
    loading: false,

    startSynchronization(workspaceId) {
      const generation = ++synchronizationGeneration
      const bridge = getBridge()
      let outputTimer: ReturnType<typeof setTimeout> | undefined
      const refresh = (): void => {
        if (generation === synchronizationGeneration) void get().refresh(workspaceId)
      }
      const immediateRefresh = (): void => {
        if (outputTimer !== undefined) clearTimeout(outputTimer)
        outputTimer = undefined
        refresh()
      }
      const debounceRefresh = (): void => {
        if (outputTimer !== undefined) clearTimeout(outputTimer)
        outputTimer = setTimeout(() => {
          outputTimer = undefined
          refresh()
        }, GIT_OUTPUT_DEBOUNCE_MS)
      }
      const refreshWorkspace = ({ workspaceId: changedWorkspaceId }: { workspaceId: string }) => {
        if (changedWorkspaceId === workspaceId) immediateRefresh()
      }
      const stops = [
        bridge.events.subscribe('git.changed', refreshWorkspace),
        bridge.events.subscribe('agent.created', immediateRefresh),
        bridge.events.subscribe('agent.queued', immediateRefresh),
        bridge.events.subscribe('agent.started', immediateRefresh),
        bridge.events.subscribe('agent.output', debounceRefresh),
        bridge.events.subscribe('agent.waiting', immediateRefresh),
        bridge.events.subscribe('agent.completed', immediateRefresh),
        bridge.events.subscribe('agent.failed', immediateRefresh),
        bridge.events.subscribe('agent.cancelled', immediateRefresh),
        bridge.events.subscribe('agent.interrupted', immediateRefresh),
      ]
      lastFocusRefreshAt.set(workspaceId, Date.now())
      void get().refresh(workspaceId)
      return () => {
        if (generation === synchronizationGeneration) synchronizationGeneration += 1
        if (outputTimer !== undefined) clearTimeout(outputTimer)
        for (const stop of stops) stop()
      }
    },

    refresh(workspaceId) {
      const existing = refreshInFlight.get(workspaceId)
      if (existing !== undefined) return existing
      const generation = ++refreshGeneration
      const pending = (async (): Promise<void> => {
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
      })()
      refreshInFlight.set(workspaceId, pending)
      void pending.finally(() => {
        if (refreshInFlight.get(workspaceId) === pending) refreshInFlight.delete(workspaceId)
      })
      return pending
    },

    refreshOnFocus(workspaceId) {
      const now = Date.now()
      const lastRefresh = lastFocusRefreshAt.get(workspaceId) ?? Number.NEGATIVE_INFINITY
      if (now - lastRefresh < GIT_FOCUS_THROTTLE_MS) return
      lastFocusRefreshAt.set(workspaceId, now)
      void get().refresh(workspaceId)
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
