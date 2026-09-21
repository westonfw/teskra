import type {
  AgentAccountProfile,
  AgentContinuationReason,
  AgentRun,
  ContinueAgentRunRequest,
  IpcResult,
  PublicAppError,
} from '@teskra/contracts'
import { create } from 'zustand'
import { transportError } from '../i18n'

export interface ContinuationStoreBridge {
  readonly agent: {
    continueWithProfile(request: ContinueAgentRunRequest): Promise<IpcResult<AgentRun>>
  }
  readonly account: {
    list(request?: { agentId?: string }): Promise<IpcResult<AgentAccountProfile[]>>
  }
}

interface ContinuationState {
  readonly open: boolean
  readonly sourceRun?: AgentRun | undefined
  readonly profiles: readonly AgentAccountProfile[]
  readonly refreshing: boolean
  readonly submitting: boolean
  readonly error?: PublicAppError | undefined
  /** Opens the modal for a rate-limited run and triggers the candidate refresh. */
  openFor(run: AgentRun): void
  /**
   * One account.list round-trip — this is also Main's §18.0 lazy limited-sweep
   * trigger, so expired `limited` rows come back demoted before the UI judges
   * availability (TASK-108).
   */
  refresh(): Promise<void>
  continueWith(targetAgentId: string, targetAccountProfileId: string): Promise<AgentRun | undefined>
  close(): void
  clearError(): void
}

export function createContinuationStore(getBridge: () => ContinuationStoreBridge) {
  let refreshGeneration = 0

  return create<ContinuationState>((set, get) => ({
    open: false,
    profiles: [],
    refreshing: false,
    submitting: false,

    openFor(run) {
      set({ open: true, sourceRun: run, error: undefined })
      void get().refresh()
    },

    async refresh() {
      const generation = ++refreshGeneration
      set({ refreshing: true })
      try {
        const result = await getBridge().account.list()
        if (generation !== refreshGeneration) return
        set(
          result.ok
            ? { profiles: result.data, refreshing: false }
            : { error: result.error, refreshing: false },
        )
      } catch {
        if (generation === refreshGeneration) {
          set({ error: transportError(), refreshing: false })
        }
      }
    },

    async continueWith(targetAgentId, targetAccountProfileId) {
      const sourceRun = get().sourceRun
      if (sourceRun === undefined) return undefined
      set({ submitting: true, error: undefined })
      try {
        // P1-2: declare WHY the switch happens. Main honors this declaration
        // only for a LIVE source run (flow B — a live run has no persisted
        // classification to consult, and only runs the output-tail classifier
        // for 'rate-limit', so anything else keeps the source profile's
        // status untouched). For an already terminal source (flow A) Main
        // ignores it and derives the reason from the persisted terminal
        // classification, so a stale snapshot here can never overwrite the
        // terminal truth.
        const reason: AgentContinuationReason =
          sourceRun.failureClassification?.kind === 'rate-limited'
            ? 'rate-limit'
            : sourceRun.status === 'failed'
              ? 'agent-failure'
              : 'manual-switch'
        const result = await getBridge().agent.continueWithProfile({
          sourceRunId: sourceRun.id,
          targetAgentId,
          targetAccountProfileId,
          reason,
        })
        if (!result.ok) {
          set({ submitting: false, error: result.error })
          return undefined
        }
        set({ submitting: false, open: false, sourceRun: undefined })
        return result.data
      } catch {
        set({ submitting: false, error: transportError() })
        return undefined
      }
    },

    close() {
      refreshGeneration += 1
      set({ open: false, sourceRun: undefined, error: undefined, refreshing: false })
    },

    clearError() {
      set({ error: undefined })
    },
  }))
}

export const useContinuationStore = createContinuationStore(() => window.teskra)
