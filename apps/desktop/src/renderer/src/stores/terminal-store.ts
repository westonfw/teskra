import type {
  CreateTerminalRequest,
  IpcResult,
  PublicAppError,
  TerminalSession,
  WorkbenchEvents,
} from '@teskra/contracts'
import { create } from 'zustand'
import { transportError } from '../i18n'

export const TERMINAL_HISTORY_MAX_CHARS = 2_000_000
const EXIT_MARKER = '\r\n\x1b[90m[terminal exited]\x1b[0m\r\n'

export interface TerminalTab {
  readonly session: TerminalSession
  readonly status: 'running' | 'closed'
}

/**
 * P1-2: history is a ring of output chunks, not one growing string. Appending
 * is O(chunks) instead of O(total); the join happens only when a terminal
 * surface mounts and needs replay text (`historyText`).
 */
export interface TerminalHistory {
  readonly chunks: readonly string[]
  readonly length: number
}

/** Joins a terminal's buffered chunks into replay text for initialData. */
export function historyText(entry: TerminalHistory | undefined): string | undefined {
  return entry === undefined ? undefined : entry.chunks.join('')
}

export interface TerminalStoreBridge {
  readonly terminal: {
    create(request: CreateTerminalRequest): Promise<IpcResult<TerminalSession>>
    close(request: { terminalId: string }): Promise<IpcResult<void>>
    get(request: { terminalId: string }): Promise<IpcResult<TerminalSession | null>>
    list(request?: { workspaceId?: string | undefined }): Promise<IpcResult<TerminalSession[]>>
  }
  readonly events: {
    subscribe<Name extends 'terminal.created' | 'terminal.output' | 'terminal.closed'>(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}

interface TerminalState {
  readonly tabs: readonly TerminalTab[]
  readonly activeId?: string | undefined
  readonly history: Readonly<Record<string, TerminalHistory>>
  readonly error?: PublicAppError | undefined
  readonly loading: boolean
  startSynchronization(): () => void
  synchronize(workspaceId?: string): Promise<void>
  createTerminal(request: CreateTerminalRequest): Promise<TerminalSession | undefined>
  closeTerminal(terminalId: string): Promise<boolean>
  dismissTerminal(terminalId: string): void
  activate(terminalId: string): void
  clearError(): void
}

function appendHistory(
  history: Readonly<Record<string, TerminalHistory>>,
  id: string,
  data: string,
): Readonly<Record<string, TerminalHistory>> {
  const previous = history[id]
  const chunks = [...(previous?.chunks ?? []), data]
  let length = (previous?.length ?? 0) + data.length
  let dropped = 0
  // Drop whole chunks from the front (newest data always survives, even a
  // single chunk larger than the cap).
  while (length > TERMINAL_HISTORY_MAX_CHARS && dropped < chunks.length - 1) {
    length -= (chunks[dropped] as string).length
    dropped += 1
  }
  return {
    ...history,
    [id]: { chunks: dropped === 0 ? chunks : chunks.slice(dropped), length },
  }
}

export function createTerminalStore(getBridge: () => TerminalStoreBridge) {
  let synchronizationUsers = 0
  let stopSynchronization: (() => void) | undefined

  return create<TerminalState>((set, get) => ({
    tabs: [],
    history: {},
    loading: false,

    startSynchronization() {
      synchronizationUsers += 1
      if (stopSynchronization === undefined) {
        const bridge = getBridge()
        const stopOutput = bridge.events.subscribe('terminal.output', ({ terminalId, data }) => {
          set((state) => ({ history: appendHistory(state.history, terminalId, data) }))
        })
        const stopClosed = bridge.events.subscribe('terminal.closed', ({ terminalId }) => {
          set((state) => ({
            tabs: state.tabs.map((tab) =>
              tab.session.id === terminalId ? { ...tab, status: 'closed' } : tab,
            ),
            history: appendHistory(state.history, terminalId, EXIT_MARKER),
          }))
        })
        const stopCreated = bridge.events.subscribe('terminal.created', ({ terminalId }) => {
          void bridge.terminal
            .get({ terminalId })
            .then((result) => {
              if (!result.ok) set({ error: result.error })
              else if (result.data !== null) {
                const session = result.data
                set((state) => ({
                  tabs: state.tabs.some((tab) => tab.session.id === terminalId)
                    ? state.tabs
                    : [...state.tabs, { session, status: 'running' }],
                  activeId: state.activeId ?? terminalId,
                }))
              }
            })
            .catch(() => set({ error: transportError() }))
        })
        stopSynchronization = () => {
          stopOutput()
          stopClosed()
          stopCreated()
        }
      }

      let active = true
      return () => {
        if (!active) return
        active = false
        synchronizationUsers -= 1
        if (synchronizationUsers === 0) {
          stopSynchronization?.()
          stopSynchronization = undefined
        }
      }
    },

    async synchronize(workspaceId) {
      set({ loading: true, error: undefined })
      try {
        const result = await getBridge().terminal.list({ workspaceId })
        if (!result.ok) {
          set({ loading: false, error: result.error })
          return
        }
        set((state) => {
          const outsideScope =
            workspaceId === undefined
              ? []
              : state.tabs.filter((tab) => tab.session.workspaceId !== workspaceId)
          const closedInScope = state.tabs.filter(
            (tab) =>
              tab.status === 'closed' &&
              (workspaceId === undefined || tab.session.workspaceId === workspaceId),
          )
          const live = result.data.map((session) => ({ session, status: 'running' as const }))
          const currentTabs = [
            ...live,
            ...closedInScope.filter(
              (tab) => !live.some(({ session }) => session.id === tab.session.id),
            ),
          ]
          const tabs = [...outsideScope, ...currentTabs]
          return {
            tabs,
            activeId: currentTabs.some((tab) => tab.session.id === state.activeId)
              ? state.activeId
              : currentTabs[0]?.session.id,
            loading: false,
          }
        })
      } catch {
        set({ loading: false, error: transportError() })
      }
    },

    async createTerminal(request) {
      set({ error: undefined })
      try {
        const result = await getBridge().terminal.create(request)
        if (!result.ok) {
          set({ error: result.error })
          return undefined
        }
        set((state) => ({
          tabs: state.tabs.some((tab) => tab.session.id === result.data.id)
            ? state.tabs
            : [...state.tabs, { session: result.data, status: 'running' }],
          activeId: result.data.id,
        }))
        return result.data
      } catch {
        set({ error: transportError() })
        return undefined
      }
    },

    async closeTerminal(terminalId) {
      const tab = get().tabs.find((candidate) => candidate.session.id === terminalId)
      if (tab === undefined) return true
      if (tab.status === 'running') {
        try {
          const result = await getBridge().terminal.close({ terminalId })
          if (!result.ok) {
            set({ error: result.error })
            return false
          }
        } catch {
          set({ error: transportError() })
          return false
        }
      }
      get().dismissTerminal(terminalId)
      return true
    },

    dismissTerminal(terminalId) {
      set((state) => {
        const tabs = state.tabs.filter((tab) => tab.session.id !== terminalId)
        const history = { ...state.history }
        delete history[terminalId]
        return {
          tabs,
          history,
          activeId: state.activeId === terminalId ? tabs[0]?.session.id : state.activeId,
        }
      })
    },

    activate(activeId) {
      if (get().tabs.some((tab) => tab.session.id === activeId)) set({ activeId })
    },

    clearError() {
      set({ error: undefined })
    },
  }))
}

export const useTerminalStore = createTerminalStore(() => window.teskra)
