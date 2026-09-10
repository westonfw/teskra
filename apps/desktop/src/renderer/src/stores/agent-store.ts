import type {
  AgentDefinition,
  AgentDetectionResult,
  AgentHealth,
  AgentRun,
  IpcResult,
  PublicAppError,
  StartAgentRunRequest,
  WorkbenchEvents,
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
    listHealth(request: {
      runtime: WorkspaceRuntimeRef
      refresh?: boolean
    }): Promise<IpcResult<AgentHealth[]>>
    getExecutableOverride(request: {
      agentId: string
      runtime: WorkspaceRuntimeRef
    }): Promise<IpcResult<string | null>>
    setExecutableOverride(request: {
      agentId: string
      runtime: WorkspaceRuntimeRef
      path: string | null
    }): Promise<IpcResult<string | null>>
    start(request: StartAgentRunRequest): Promise<IpcResult<AgentRun>>
    cancel(request: { runId: string }): Promise<IpcResult<AgentRun>>
    get(request: { runId: string }): Promise<IpcResult<AgentRun | null>>
    list(request?: { workspaceId?: string; activeOnly?: boolean }): Promise<IpcResult<AgentRun[]>>
  }
  readonly events: {
    subscribe<
      Name extends
        | 'agent.created'
        | 'agent.queued'
        | 'agent.started'
        | 'agent.output'
        | 'agent.waiting'
        | 'agent.completed'
        | 'agent.failed'
        | 'agent.cancelled',
    >(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}

interface AgentState {
  readonly definitions: readonly AgentDefinition[]
  readonly detections: Readonly<Record<string, AgentDetectionResult | undefined>>
  readonly health: Readonly<Record<string, AgentHealth | undefined>>
  readonly executableOverrides: Readonly<Record<string, string | null | undefined>>
  readonly runs: readonly AgentRun[]
  readonly activity: Readonly<Record<string, string | undefined>>
  readonly loading: boolean
  readonly runsLoading: boolean
  readonly starting: boolean
  readonly error?: PublicAppError
  startSynchronization(workspaceId: string): () => void
  synchronizeRuns(workspaceId: string): Promise<void>
  startRun(request: StartAgentRunRequest): Promise<AgentRun | undefined>
  cancelRun(runId: string): Promise<boolean>
  loadDefinitions(): Promise<void>
  detect(agentId: string, runtime: WorkspaceRuntimeRef): Promise<void>
  loadHealth(runtime: WorkspaceRuntimeRef): Promise<void>
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
  let synchronizationGeneration = 0
  let runsLoadGeneration = 0

  return create<AgentState>((set, get) => ({
    definitions: [],
    detections: {},
    health: {},
    executableOverrides: {},
    runs: [],
    activity: {},
    loading: false,
    runsLoading: false,
    starting: false,

    startSynchronization(workspaceId) {
      const generation = ++synchronizationGeneration
      const bridge = getBridge()
      const refreshRun = ({ runId }: { runId: string }): void => {
        void bridge.agent
          .get({ runId })
          .then((result) => {
            if (generation !== synchronizationGeneration) return
            if (!result.ok) {
              set({ error: result.error })
              return
            }
            const refreshed = result.data
            if (refreshed !== null && refreshed.workspaceId === workspaceId) {
              set((state) => ({ runs: upsertRun(state.runs, refreshed) }))
            }
          })
          .catch(() => {
            if (generation === synchronizationGeneration) set({ error: transportError })
          })
      }
      const stops = [
        bridge.events.subscribe('agent.created', refreshRun),
        bridge.events.subscribe('agent.queued', refreshRun),
        bridge.events.subscribe('agent.started', refreshRun),
        bridge.events.subscribe('agent.waiting', refreshRun),
        bridge.events.subscribe('agent.completed', refreshRun),
        bridge.events.subscribe('agent.failed', refreshRun),
        bridge.events.subscribe('agent.cancelled', refreshRun),
        bridge.events.subscribe('agent.output', ({ runId, data }) => {
          if (generation !== synchronizationGeneration) return
          set((state) =>
            state.runs.some(({ id }) => id === runId)
              ? { activity: { ...state.activity, [runId]: activitySummary(data) } }
              : {},
          )
        }),
      ]
      void get().synchronizeRuns(workspaceId)

      return () => {
        if (generation === synchronizationGeneration) synchronizationGeneration += 1
        for (const stop of stops) stop()
      }
    },

    async synchronizeRuns(workspaceId) {
      const generation = ++runsLoadGeneration
      set({ runsLoading: true, error: undefined })
      try {
        const result = await getBridge().agent.list({ workspaceId })
        if (generation !== runsLoadGeneration) return
        if (!result.ok) {
          set({ runsLoading: false, error: result.error })
          return
        }
        set({ runs: sortRuns(result.data), runsLoading: false })
      } catch {
        if (generation === runsLoadGeneration) set({ runsLoading: false, error: transportError })
      }
    },

    async startRun(request) {
      set({ starting: true, error: undefined })
      try {
        const result = await getBridge().agent.start(request)
        if (!result.ok) {
          set({ starting: false, error: result.error })
          return undefined
        }
        set((state) => ({ runs: upsertRun(state.runs, result.data), starting: false }))
        return result.data
      } catch {
        set({ starting: false, error: transportError })
        return undefined
      }
    },

    async cancelRun(runId) {
      set({ error: undefined })
      try {
        const result = await getBridge().agent.cancel({ runId })
        if (!result.ok) {
          set({ error: result.error })
          return false
        }
        set((state) => ({ runs: upsertRun(state.runs, result.data) }))
        return true
      } catch {
        set({ error: transportError })
        return false
      }
    },

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

    async loadHealth(runtime) {
      set({ error: undefined })
      try {
        const result = await getBridge().agent.listHealth({ runtime, refresh: true })
        if (!result.ok) {
          set({ error: result.error })
          return
        }
        set((state) => ({
          health: result.data.reduce<Record<string, AgentHealth | undefined>>(
            (health, item) => ({
              ...health,
              [agentRuntimeKey(item.agentId, item.runtime)]: item,
            }),
            { ...state.health },
          ),
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

function sortRuns(runs: readonly AgentRun[]): AgentRun[] {
  return [...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

function upsertRun(runs: readonly AgentRun[], run: AgentRun): AgentRun[] {
  return sortRuns([run, ...runs.filter(({ id }) => id !== run.id)])
}

function activitySummary(data: string): string {
  const plain = data
    .replaceAll('\u001b', '')
    .replaceAll(/\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  return (plain ?? 'Agent produced output').slice(0, 180)
}

export const useAgentStore = createAgentStore(() => window.teskra)
