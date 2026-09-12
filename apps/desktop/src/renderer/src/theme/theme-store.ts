import { create } from 'zustand'

export const THEME_MODES = ['dark', 'light'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

const STORAGE_KEY = 'teskra.theme'
const DEFAULT_THEME: ThemeMode = 'light'

function readInitialTheme(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return THEME_MODES.includes(stored as ThemeMode) ? (stored as ThemeMode) : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

interface ThemeState {
  readonly theme: ThemeMode
  setTheme(theme: ThemeMode): void
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: readInitialTheme(),
  setTheme(theme) {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // localStorage may be unavailable (private mode); the session value still applies.
    }
    set({ theme })
  },
}))
