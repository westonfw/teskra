import type {
  IpcResult,
  ListDecisionsRequest,
  PendingDecision,
  PublicAppError,
  ResolveDecisionRequest,
} from '@teskra/contracts'
import { create } from 'zustand'

import { transportError } from '../i18n'

export interface InboxStoreBridge {
  readonly decision: {
    list(request?: ListDecisionsRequest): Promise<IpcResult<PendingDecision[]>>
    resolve(request: ResolveDecisionRequest): Promise<IpcResult<PendingDecision>>
  }
  readonly events: {
    subscribe<Name extends 'decision.opened' | 'decision.resolved'>(
      name: Name,
      handler: (payload: { decision: PendingDecision }) => void,
    ): () => void
  }
}

export type InboxStatus = 'idle' | 'loading' | 'ready' | 'error'

interface InboxState {
  readonly status: InboxStatus
  /** Open decisions only — the badge count is `decisions.length`. */
  readonly decisions: readonly PendingDecision[]
  readonly error?: PublicAppError | undefined
  /** Decision id currently awaiting decision.resolve; its buttons disable. */
  readonly resolvingId?: string | undefined
  load(): Promise<void>
  /** Resolves a decision with the picked option; false when the call failed. */
  resolve(id: string, optionId: string): Promise<boolean>
  clearError(): void
  /**
   * Initial pull + incremental `decision.opened` / `decision.resolved`
   * updates (TASK-131: the nav badge lives off this store, so the sync runs
   * from the app shell regardless of the current page).
   */
  startSynchronization(): () => void
}

/**
 * TASK-131 (teskra-tasks.md; design doc §9.3): the Decision Inbox store.
 * The backlog is pulled once; afterwards the two decision events keep the
 * list current without polling (the ShellConfirmationHost pattern, TASK-129).
 */
export function createInboxStore(getBridge: () => InboxStoreBridge) {
  let loadGeneration = 0
  let synchronizationGeneration = 0

  return create<InboxState>((set, get) => ({
    status: 'idle',
    decisions: [],

    async load() {
      const generation = ++loadGeneration
      set((state) => ({ status: 'loading', error: undefined, decisions: state.decisions }))
      try {
        const result = await getBridge().decision.list({ status: 'open' })
        if (generation !== loadGeneration) return
        set(
          result.ok
            ? { status: 'ready', decisions: result.data }
            : { status: 'error', error: result.error },
        )
      } catch {
        if (generation === loadGeneration) {
          set({ status: 'error', error: transportError() })
        }
      }
    },

    async resolve(id, optionId) {
      set({ resolvingId: id, error: undefined })
      try {
        const result = await getBridge().decision.resolve({ id, optionId })
        if (!result.ok) {
          set({ resolvingId: undefined, error: result.error })
          return false
        }
        // decision.resolved also arrives as an event; dropping the row here
        // keeps the UI snappy when the event loop is busy, and upsert-by-id
        // makes the later event a no-op.
        set((state) => ({
          resolvingId: undefined,
          decisions: state.decisions.filter((decision) => decision.id !== id),
        }))
        return true
      } catch {
        set({ resolvingId: undefined, error: transportError() })
        return false
      }
    },

    clearError() {
      set({ error: undefined })
    },

    startSynchronization() {
      const generation = ++synchronizationGeneration
      void get().load()
      const stops = [
        getBridge().events.subscribe('decision.opened', ({ decision }) => {
          if (generation !== synchronizationGeneration || decision.status !== 'open') return
          set((state) =>
            state.decisions.some((entry) => entry.id === decision.id)
              ? state
              : { decisions: [...state.decisions, decision] },
          )
        }),
        getBridge().events.subscribe('decision.resolved', ({ decision }) => {
          if (generation !== synchronizationGeneration) return
          set((state) => ({
            decisions: state.decisions.filter((entry) => entry.id !== decision.id),
          }))
        }),
      ]
      return () => {
        if (generation === synchronizationGeneration) synchronizationGeneration += 1
        for (const stop of stops) stop()
      }
    },
  }))
}

export const useInboxStore = createInboxStore(() => window.teskra)
