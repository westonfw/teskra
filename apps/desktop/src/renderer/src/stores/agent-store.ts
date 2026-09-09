import type { AgentDefinition, IpcResult, PublicAppError } from '@teskra/contracts'
import { create } from 'zustand'

export interface AgentStoreBridge {
  readonly agent: {
    listDefinitions(): Promise<IpcResult<AgentDefinition[]>>
  }
}

interface AgentState {
  readonly definitions: readonly AgentDefinition[]
  readonly loading: boolean
  readonly error?: PublicAppError
  loadDefinitions(): Promise<void>
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

    clearError() {
      set({ error: undefined })
    },
  }))
}

export const useAgentStore = createAgentStore(() => window.teskra)
