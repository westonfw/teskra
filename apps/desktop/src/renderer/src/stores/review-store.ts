import type {
  CriterionScoreRecord,
  IpcResult,
  ListCriterionScoresRequest,
  ListReviewFindingsRequest,
  PublicAppError,
  ReviewFindingRecord,
  WorkbenchEvents,
} from '@teskra/contracts'
import { create } from 'zustand'
import { transportError } from '../i18n'

export interface ReviewStoreBridge {
  readonly review: {
    listFindings(request: ListReviewFindingsRequest): Promise<IpcResult<ReviewFindingRecord[]>>
    listCriterionScores(
      request: ListCriterionScoresRequest,
    ): Promise<IpcResult<CriterionScoreRecord[]>>
  }
  readonly events: {
    subscribe<
      Name extends 'agent.completed' | 'agent.failed' | 'agent.cancelled' | 'task.updated',
    >(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}

interface ReviewState {
  readonly runId?: string
  readonly findings: readonly ReviewFindingRecord[]
  readonly scoreTaskId?: string
  readonly scores: readonly CriterionScoreRecord[]
  readonly loading: boolean
  readonly error?: PublicAppError
  /** Synchronizes the findings of one Run; refreshes when that Run terminates. */
  startSynchronization(runId: string): () => void
  synchronize(runId: string): Promise<void>
  /** Synchronizes the criterion scores of one Task; refreshes on Run/Task events. */
  startScoreSynchronization(taskId: string): () => void
  synchronizeScores(taskId: string): Promise<void>
  clearError(): void
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

/** Latest score per criterion (later createdAt wins). */
export function latestScoresByCriterion(
  scores: readonly CriterionScoreRecord[],
): ReadonlyMap<string, CriterionScoreRecord> {
  const latest = new Map<string, CriterionScoreRecord>()
  for (const score of scores) {
    const current = latest.get(score.criterionId)
    if (current === undefined || score.createdAt >= current.createdAt) {
      latest.set(score.criterionId, score)
    }
  }
  return latest
}

const TERMINAL_RUN_EVENTS = ['agent.completed', 'agent.failed', 'agent.cancelled'] as const

export function createReviewStore(getBridge: () => ReviewStoreBridge) {
  let synchronizationGeneration = 0
  let scoreSynchronizationGeneration = 0
  let loadGeneration = 0
  let scoreLoadGeneration = 0

  return create<ReviewState>((set, get) => ({
    findings: [],
    scores: [],
    loading: false,

    startSynchronization(runId) {
      const generation = ++synchronizationGeneration
      if (get().runId !== runId) set({ runId, findings: [] })
      // Findings land when the run terminates (ADR-0004 post-exit collection),
      // so terminal Agent events are the refresh trigger.
      const stops = TERMINAL_RUN_EVENTS.map((name) =>
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
        if (generation === loadGeneration) set({ loading: false, error: transportError() })
      }
    },

    startScoreSynchronization(taskId) {
      const generation = ++scoreSynchronizationGeneration
      if (get().scoreTaskId !== taskId) set({ scoreTaskId: taskId, scores: [] })
      const refresh = () => void get().synchronizeScores(taskId)
      const stops = [
        ...TERMINAL_RUN_EVENTS.map((name) => getBridge().events.subscribe(name, refresh)),
        getBridge().events.subscribe('task.updated', (payload) => {
          if (payload.taskId === taskId) refresh()
        }),
      ]
      void get().synchronizeScores(taskId)
      return () => {
        if (generation === scoreSynchronizationGeneration) scoreSynchronizationGeneration += 1
        for (const stop of stops) stop()
      }
    },

    async synchronizeScores(taskId) {
      const generation = ++scoreLoadGeneration
      set({ scoreTaskId: taskId, error: undefined })
      try {
        const result = await getBridge().review.listCriterionScores({ taskId })
        if (generation !== scoreLoadGeneration) return
        if (!result.ok) {
          set({ error: result.error })
          return
        }
        set({ scores: result.data })
      } catch {
        if (generation === scoreLoadGeneration) set({ error: transportError() })
      }
    },

    clearError() {
      set({ error: undefined })
    },
  }))
}

export const useReviewStore = createReviewStore(() => window.teskra)
