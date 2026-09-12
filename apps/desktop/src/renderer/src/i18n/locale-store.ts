import { create } from 'zustand'

export const LOCALES = ['en-US', 'zh-CN'] as const
export type Locale = (typeof LOCALES)[number]

const STORAGE_KEY = 'teskra.locale'
const DEFAULT_LOCALE: Locale = 'en-US'

function readInitialLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return LOCALES.includes(stored as Locale) ? (stored as Locale) : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

interface LocaleState {
  readonly locale: Locale
  setLocale(locale: Locale): void
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: readInitialLocale(),
  setLocale(locale) {
    try {
      window.localStorage.setItem(STORAGE_KEY, locale)
    } catch {
      // localStorage may be unavailable (private mode); the session value still applies.
    }
    set({ locale })
  },
}))
