import type {
  AgentDefinition,
  AgentDetectionResult,
  IpcResult,
  PublicAppError,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'
import { create } from 'zustand'

export interface AgentStoreBridge {
  readonly agent: {
    listDefinitions(): Promise<IpcResult<AgentDefinition[]>>
    detect(request: {
      agentId: string
      runtime: WorkspaceRuntimeRef
      refresh?: boolean
    }): Promise<IpcResult<AgentDetectionResult>>
    getExecutableOverride(request: {
      agentId: string
      runtime: WorkspaceRuntimeRef
    }): Promise<IpcResult<string | null>>
    setExecutableOverride(request: {
      agentId: string
      runtime: WorkspaceRuntimeRef
      path: string | null
    }): Promise<IpcResult<string | null>>
  }
}

interface AgentState {
  readonly definitions: readonly AgentDefinition[]
  readonly detections: Readonly<Record<string, AgentDetectionResult | undefined>>
  readonly executableOverrides: Readonly<Record<string, string | null | undefined>>
  readonly loading: boolean
  readonly error?: PublicAppError
  loadDefinitions(): Promise<void>
  detect(agentId: string, runtime: WorkspaceRuntimeRef): Promise<void>
  loadExecutableOverride(agentId: string, runtime: WorkspaceRuntimeRef): Promise<void>
  setExecutableOverride(
    agentId: string,
    runtime: WorkspaceRuntimeRef,
    path: string | null,
  ): Promise<boolean>
  clearError(): void
}

const transportError: PublicAppError = {
  code: 'UNKNOWN',
  message: 'Teskra could not reach the Agent Registry.',
  retryable: true,
}

export function createAgentStore(getBridge: () => AgentStoreBridge) {
  return create<AgentState>((set) => ({
    definitions: [],
    detections: {},
    executableOverrides: {},
    loading: false,

    async loadDefinitions() {
      set({ loading: true, error: undefined })
      try {
        const result = await getBridge().agent.listDefinitions()
        if (!result.ok) {
          set({ loading: false, error: result.error })
          return
        }
        set({ definitions: result.data, loading: false })
      } catch {
        set({ loading: false, error: transportError })
      }
    },

    async detect(agentId, runtime) {
      set({ error: undefined })
      try {
        const result = await getBridge().agent.detect({ agentId, runtime, refresh: true })
        if (!result.ok) {
          set({ error: result.error })
          return
        }
        set((state) => ({
          detections: { ...state.detections, [agentRuntimeKey(agentId, runtime)]: result.data },
        }))
      } catch {
        set({ error: transportError })
      }
    },

    async loadExecutableOverride(agentId, runtime) {
      set({ error: undefined })
      try {
        const result = await getBridge().agent.getExecutableOverride({ agentId, runtime })
        if (!result.ok) {
          set({ error: result.error })
          return
        }
        set((state) => ({
          executableOverrides: {
            ...state.executableOverrides,
            [agentRuntimeKey(agentId, runtime)]: result.data,
          },
        }))
      } catch {
        set({ error: transportError })
      }
    },

    async setExecutableOverride(agentId, runtime, path) {
      set({ error: undefined })
      try {
        const result = await getBridge().agent.setExecutableOverride({ agentId, runtime, path })
        if (!result.ok) {
          set({ error: result.error })
          return false
        }
        set((state) => ({
          executableOverrides: {
            ...state.executableOverrides,
            [agentRuntimeKey(agentId, runtime)]: result.data,
          },
        }))
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

export function agentRuntimeKey(agentId: string, runtime: WorkspaceRuntimeRef): string {
  return JSON.stringify([agentId, runtime])
}

export const useAgentStore = createAgentStore(() => window.teskra)
