import type {
  PublicAppError,
  ResolvedConfig,
  SystemDirectoryKind,
  TeskraConfigLayer,
  WritableConfigLayer,
} from '@teskra/contracts'
import { create } from 'zustand'

interface SettingsState {
  readonly workspaceId?: string
  readonly targetLayer: WritableConfigLayer
  readonly resolved?: ResolvedConfig
  readonly loading: boolean
  readonly saving: boolean
  readonly error?: PublicAppError
  setWorkspace(workspaceId?: string): Promise<void>
  setTargetLayer(layer: WritableConfigLayer): void
  load(): Promise<void>
  save(patch: TeskraConfigLayer): Promise<boolean>
  openDirectory(kind: SystemDirectoryKind): Promise<boolean>
  clearError(): void
}

const transportError: PublicAppError = {
  code: 'UNKNOWN',
  message: 'Teskra could not reach the main process.',
  retryable: true,
}

let loadGeneration = 0

export const useSettingsStore = create<SettingsState>((set, get) => ({
  targetLayer: 'global',
  loading: false,
  saving: false,

  async setWorkspace(workspaceId) {
    set((state) => ({
      workspaceId,
      targetLayer: workspaceId === undefined ? 'global' : state.targetLayer,
    }))
    await get().load()
  },

  setTargetLayer(targetLayer) {
    if (targetLayer === 'workspace' && get().workspaceId === undefined) return
    set({ targetLayer })
  },

  async load() {
    const generation = ++loadGeneration
    set({ loading: true, error: undefined })
    try {
      const result = await window.teskra.settings.resolveConfig({
        workspaceId: get().workspaceId,
      })
      if (generation !== loadGeneration) return
      set(
        result.ok
          ? { resolved: result.data, loading: false }
          : { error: result.error, loading: false },
      )
    } catch {
      if (generation === loadGeneration) set({ error: transportError, loading: false })
    }
  },

  async save(patch) {
    const { targetLayer, workspaceId } = get()
    set({ saving: true, error: undefined })
    try {
      const result = await window.teskra.settings.updateConfig({
        layer: targetLayer,
        workspaceId,
        patch,
      })
      set(
        result.ok
          ? { resolved: result.data, saving: false }
          : { error: result.error, saving: false },
      )
      return result.ok
    } catch {
      set({ error: transportError, saving: false })
      return false
    }
  },

  async openDirectory(kind) {
    set({ error: undefined })
    try {
      const result = await window.teskra.settings.openDirectory({ kind })
      if (!result.ok) set({ error: result.error })
      return result.ok
    } catch {
      set({ error: transportError })
      return false
    }
  },

  clearError() {
    set({ error: undefined })
  },
}))
