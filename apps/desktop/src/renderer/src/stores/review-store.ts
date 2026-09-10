import type {
  IpcResult,
  ListReviewFindingsRequest,
  PublicAppError,
  ReviewFindingRecord,
  WorkbenchEvents,
} from '@teskra/contracts'
import { create } from 'zustand'

export interface ReviewStoreBridge {
  readonly review: {
    listFindings(request: ListReviewFindingsRequest): Promise<IpcResult<ReviewFindingRecord[]>>
  }
  readonly events: {
    subscribe<Name extends 'agent.completed' | 'agent.failed' | 'agent.cancelled'>(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}

interface ReviewState {
  readonly runId?: string
  readonly findings: readonly ReviewFindingRecord[]
  readonly loading: boolean
  readonly error?: PublicAppError
  /** Synchronizes the findings of one Run; refreshes when that Run terminates. */
  startSynchronization(runId: string): () => void
  synchronize(runId: string): Promise<void>
  clearError(): void
}

const transportError: PublicAppError = {
  code: 'UNKNOWN',
  message: 'Teskra could not reach the Review service.',
  retryable: true,
}

const SEVERITY_RANK: Record<ReviewFindingRecord['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/** Most severe first; stable within one severity by creation order. */
export function sortFindingsBySeverity(
  findings: readonly ReviewFindingRecord[],
): ReviewFindingRecord[] {
  return [...findings].sort((left, right) => {
    const rank = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
    return rank !== 0 ? rank : left.createdAt.localeCompare(right.createdAt)
  })
}

export function createReviewStore(getBridge: () => ReviewStoreBridge) {
  let synchronizationGeneration = 0
  let loadGeneration = 0

  return create<ReviewState>((set, get) => ({
    findings: [],
    loading: false,

    startSynchronization(runId) {
      const generation = ++synchronizationGeneration
      if (get().runId !== runId) set({ runId, findings: [] })
      // Findings land when the run terminates (ADR-0004 post-exit collection),
      // so terminal Agent events are the refresh trigger.
      const stops = (
        ['agent.completed', 'agent.failed', 'agent.cancelled'] as const
      ).map((name) =>
        getBridge().events.subscribe(name, (payload) => {
          if (payload.runId === runId) void get().synchronize(runId)
        }),
      )
      void get().synchronize(runId)
      return () => {
        if (generation === synchronizationGeneration) synchronizationGeneration += 1
        for (const stop of stops) stop()
      }
    },

    async synchronize(runId) {
      const generation = ++loadGeneration
      set({ runId, loading: true, error: undefined })
      try {
        const result = await getBridge().review.listFindings({ runId })
        if (generation !== loadGeneration) return
        if (!result.ok) {
          set({ loading: false, error: result.error })
          return
        }
        set({ findings: result.data, loading: false })
      } catch {
        if (generation === loadGeneration) set({ loading: false, error: transportError })
      }
    },

    clearError() {
      set({ error: undefined })
    },
  }))
}

export const useReviewStore = createReviewStore(() => window.teskra)
