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

interface NavigationState {
  readonly page: WorkbenchPage
  navigate(page: WorkbenchPage): void
}

export const useNavigationStore = create<NavigationState>((set) => ({
  page: 'home',
  navigate: (page) => set({ page }),
}))
