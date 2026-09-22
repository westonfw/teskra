import { create } from 'zustand'

export const WORKBENCH_PAGES = [
  'home',
  'workspace',
  'tasks',
  'runs',
  'inbox',
  'git',
  'terminal',
  'doctor',
  'recovery',
  'settings',
] as const
export type WorkbenchPage = (typeof WORKBENCH_PAGES)[number]

export interface NavigationIntent {
  /** Open a specific Run's detail drawer after landing on the page. */
  readonly openRunId?: string
  /** Select a specific Task (its Thread tab) after landing on the Tasks page. */
  readonly openTaskId?: string
}

interface NavigationState {
  readonly page: WorkbenchPage
  readonly pendingRunId?: string | undefined
  readonly pendingTaskId?: string | undefined
  navigate(page: WorkbenchPage, intent?: NavigationIntent): void
  /** Reads and clears the pending Run intent; undefined when none is set. */
  consumePendingRunId(): string | undefined
  /** Reads and clears the pending Task intent; undefined when none is set. */
  consumePendingTaskId(): string | undefined
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  page: 'home',
  navigate: (page, intent) =>
    set({ page, pendingRunId: intent?.openRunId, pendingTaskId: intent?.openTaskId }),
  consumePendingRunId: () => {
    const pending = get().pendingRunId
    if (pending !== undefined) set({ pendingRunId: undefined })
    return pending
  },
  consumePendingTaskId: () => {
    const pending = get().pendingTaskId
    if (pending !== undefined) set({ pendingTaskId: undefined })
    return pending
  },
}))
