import type {
  DiffResult,
  GitRawDiff,
  GitStatus,
  IpcResult,
  PublicAppError,
  WorkbenchEvents,
} from '@teskra/contracts'
import { create } from 'zustand'
import { transportError } from '../i18n'

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
    filePatch(request: { workspaceId: string; path: string }): Promise<IpcResult<GitRawDiff>>
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
  /** Lazy per-file patches, keyed by path; filled by loadPatch (P1-5). */
  readonly patches: Readonly<Record<string, string>>
  readonly patchLoading: boolean
  readonly selectedPath?: string | undefined
  readonly loading: boolean
  readonly error?: PublicAppError | undefined
  /**
   * Bumped by every completed refresh (the same set() that clears the patch
   * cache). The lazy-patch effect keys on it so a patch that never got
   * cached — an in-flight fetch voided by the refresh's generation check, or
   * an IPC failure that only set `error` — is retried on the next refresh
   * instead of leaving the diff panel blank forever.
   */
  readonly refreshCount: number
  startSynchronization(workspaceId: string): () => void
  refresh(workspaceId: string): Promise<void>
  refreshOnFocus(workspaceId: string): void
  selectFile(path?: string): void
  loadPatch(workspaceId: string, path: string): Promise<void>
  openFile(workspaceId: string, path: string): Promise<boolean>
  clearError(): void
}

export function createGitStore(getBridge: () => GitStoreBridge) {
  let synchronizationGeneration = 0
  let refreshGeneration = 0
  const refreshInFlight = new Map<string, Promise<void>>()
  const lastFocusRefreshAt = new Map<string, number>()
  const patchInFlight = new Set<string>()

  return create<GitState>((set, get) => ({
    changes: { files: [] },
    patches: {},
    patchLoading: false,
    loading: false,
    refreshCount: 0,

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
            // Stale patches must never survive a refresh: file contents may
            // have changed, so the next selection re-fetches its patch.
            patches: {},
            refreshCount: state.refreshCount + 1,
            selectedPath:
              changes.data.files.find(({ path }) => path === state.selectedPath)?.path ??
              changes.data.files[0]?.path,
            loading: false,
          }))
        } catch {
          if (generation === refreshGeneration) set({ loading: false, error: transportError() })
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

    async loadPatch(workspaceId, path) {
      const key = `${workspaceId} ${path}`
      if (get().patches[path] !== undefined || patchInFlight.has(key)) return
      // A refresh invalidates loaded patches; a fetch that started before it
      // must not write its (now stale) result back afterwards.
      const generation = refreshGeneration
      patchInFlight.add(key)
      set({ patchLoading: true })
      try {
        const result = await getBridge().git.filePatch({ workspaceId, path })
        if (generation !== refreshGeneration) return
        if (!result.ok) {
          set({ error: result.error })
          return
        }
        set((state) => ({ patches: { ...state.patches, [path]: result.data.patch } }))
      } catch {
        if (generation === refreshGeneration) set({ error: transportError() })
      } finally {
        patchInFlight.delete(key)
        set({ patchLoading: patchInFlight.size > 0 })
        // A refresh invalidated this fetch mid-flight: its result was dropped
        // and the cache it was filling was cleared. Re-issue under the
        // current generation or the panel stays blank (the effect's inputs
        // did not change).
        if (generation !== refreshGeneration) void get().loadPatch(workspaceId, path)
      }
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
        set({ error: transportError() })
        return false
      }
    },

    clearError() {
      set({ error: undefined })
    },
  }))
}

export const useGitStore = createGitStore(() => window.teskra)
