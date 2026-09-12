import type {
  IpcResult,
  ListReviewPanelsRequest,
  PublicAppError,
  ReviewPanel,
  ReviewPanelIdRequest,
  ReviewPanelResult,
  WorkbenchEvents,
} from '@teskra/contracts'
import { create } from 'zustand'
import { transportError } from '../i18n'

export interface ReviewPanelStoreBridge {
  readonly review: {
    listPanels(request: ListReviewPanelsRequest): Promise<IpcResult<ReviewPanel[]>>
    getPanel(request: ReviewPanelIdRequest): Promise<IpcResult<ReviewPanelResult | null>>
  }
  readonly events: {
    subscribe<Name extends 'review.panel_updated' | 'task.updated'>(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}

/**
 * ReviewPanelStore (TASK-061) — keeps the selected Task's review panels and
 * the opened panel's aggregate (verdict, per-reviewer summaries, findings,
 * disagreements) in sync; refreshes when a panel converges.
 */
interface ReviewPanelState {
  readonly taskId?: string
  readonly panels: readonly ReviewPanel[]
  readonly selectedId?: string
  readonly detail?: ReviewPanelResult
  readonly loading: boolean
  readonly error?: PublicAppError
  /** Synchronizes the panels of one Task; refreshes on panel/task events. */
  startSynchronization(taskId: string): () => void
  synchronize(taskId: string): Promise<void>
  /** Opens (or closes, with undefined) a panel's aggregate detail. */
  selectPanel(panelId: string | undefined): Promise<void>
  clearError(): void
}

export function createReviewPanelStore(getBridge: () => ReviewPanelStoreBridge) {
  let synchronizationGeneration = 0
  let loadGeneration = 0
  let detailGeneration = 0

  return create<ReviewPanelState>((set, get) => ({
    panels: [],
    loading: false,

    startSynchronization(taskId) {
      const generation = ++synchronizationGeneration
      if (get().taskId !== taskId) set({ taskId, panels: [], selectedId: undefined, detail: undefined })
      const refresh = () => void get().synchronize(taskId)
      const stops = [
        getBridge().events.subscribe('review.panel_updated', (payload) => {
          if (payload.taskId === taskId) refresh()
        }),
        getBridge().events.subscribe('task.updated', (payload) => {
          if (payload.taskId === taskId) refresh()
        }),
      ]
      void get().synchronize(taskId)
      return () => {
        if (generation === synchronizationGeneration) synchronizationGeneration += 1
        for (const stop of stops) stop()
      }
    },

    async synchronize(taskId) {
      const generation = ++loadGeneration
      set({ taskId, loading: true, error: undefined })
      try {
        const result = await getBridge().review.listPanels({ taskId })
        if (generation !== loadGeneration) return
        if (!result.ok) {
          set({ loading: false, error: result.error })
          return
        }
        set({ panels: result.data, loading: false })
        // Keep an open detail fresh as its panel row changes.
        const selectedId = get().selectedId
        if (selectedId !== undefined) void get().selectPanel(selectedId)
      } catch {
        if (generation === loadGeneration) set({ loading: false, error: transportError() })
      }
    },

    async selectPanel(panelId) {
      const generation = ++detailGeneration
      if (panelId === undefined) {
        set({ selectedId: undefined, detail: undefined })
        return
      }
      set({ selectedId: panelId, error: undefined })
      try {
        const result = await getBridge().review.getPanel({ panelId })
        if (generation !== detailGeneration) return
        if (!result.ok) {
          set({ error: result.error })
          return
        }
        set({ detail: result.data ?? undefined })
      } catch {
        if (generation === detailGeneration) set({ error: transportError() })
      }
    },

    clearError() {
      set({ error: undefined })
    },
  }))
}

export const useReviewPanelStore = createReviewPanelStore(() => window.teskra)
