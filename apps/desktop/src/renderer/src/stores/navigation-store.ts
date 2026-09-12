import { create } from 'zustand'

export const WORKBENCH_PAGES = [
  'home',
  'workspace',
  'tasks',
  'runs',
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
}

interface NavigationState {
  readonly page: WorkbenchPage
  readonly pendingRunId?: string | undefined
  navigate(page: WorkbenchPage, intent?: NavigationIntent): void
  /** Reads and clears the pending Run intent; undefined when none is set. */
  consumePendingRunId(): string | undefined
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  page: 'home',
  navigate: (page, intent) => set({ page, pendingRunId: intent?.openRunId }),
  consumePendingRunId: () => {
    const pending = get().pendingRunId
    if (pending !== undefined) set({ pendingRunId: undefined })
    return pending
  },
}))
