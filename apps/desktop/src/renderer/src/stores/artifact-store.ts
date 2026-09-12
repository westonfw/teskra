import type {
  Artifact,
  ArtifactContent,
  IpcResult,
  ListArtifactsRequest,
  PublicAppError,
  WorkbenchEvents,
} from '@teskra/contracts'
import { create } from 'zustand'
import { transportError } from '../i18n'

export interface ArtifactStoreBridge {
  readonly artifact: {
    list(request: ListArtifactsRequest): Promise<IpcResult<Artifact[]>>
    get(request: { artifactId: string }): Promise<IpcResult<ArtifactContent | null>>
    scanRun(request: { runId: string }): Promise<IpcResult<Artifact[]>>
  }
  readonly events: {
    subscribe<Name extends 'task.updated'>(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}

interface ArtifactState {
  readonly taskId?: string
  readonly artifacts: readonly Artifact[]
  readonly loading: boolean
  readonly scanning: boolean
  readonly error?: PublicAppError
  startSynchronization(taskId: string): () => void
  synchronize(taskId: string): Promise<void>
  /** Resolves an Artifact's payload for display; undefined on failure. */
  loadContent(artifactId: string): Promise<ArtifactContent | undefined>
  /** Registers files the given Runs dropped into their artifact directories. */
  scanRuns(runIds: readonly string[]): Promise<boolean>
  clearError(): void
}

export function createArtifactStore(getBridge: () => ArtifactStoreBridge) {
  let synchronizationGeneration = 0
  let loadGeneration = 0

  return create<ArtifactState>((set, get) => ({
    artifacts: [],
    loading: false,
    scanning: false,

    startSynchronization(taskId) {
      const generation = ++synchronizationGeneration
      if (get().taskId !== taskId) set({ taskId, artifacts: [] })
      const stop = getBridge().events.subscribe('task.updated', (payload) => {
        if (payload.taskId === taskId) void get().synchronize(taskId)
      })
      void get().synchronize(taskId)
      return () => {
        if (generation === synchronizationGeneration) synchronizationGeneration += 1
        stop()
      }
    },

    async synchronize(taskId) {
      const generation = ++loadGeneration
      set({ taskId, loading: true, error: undefined })
      try {
        const result = await getBridge().artifact.list({ taskId })
        if (generation !== loadGeneration) return
        if (!result.ok) {
          set({ loading: false, error: result.error })
          return
        }
        set({ artifacts: result.data, loading: false })
      } catch {
        if (generation === loadGeneration) set({ loading: false, error: transportError() })
      }
    },

    async loadContent(artifactId) {
      set({ error: undefined })
      try {
        const result = await getBridge().artifact.get({ artifactId })
        if (!result.ok) {
          set({ error: result.error })
          return undefined
        }
        return result.data ?? undefined
      } catch {
        set({ error: transportError() })
        return undefined
      }
    },

    async scanRuns(runIds) {
      set({ scanning: true, error: undefined })
      try {
        for (const runId of runIds) {
          const scanned = await getBridge().artifact.scanRun({ runId })
          if (!scanned.ok) {
            set({ scanning: false, error: scanned.error })
            return false
          }
        }
        const { taskId } = get()
        if (taskId !== undefined) await get().synchronize(taskId)
        set({ scanning: false })
        return true
      } catch {
        set({ scanning: false, error: transportError() })
        return false
      }
    },

    clearError() {
      set({ error: undefined })
    },
  }))
}

export const useArtifactStore = createArtifactStore(() => window.teskra)
