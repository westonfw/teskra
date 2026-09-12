import { enUS, type TranslationKey, type TranslationParams } from './en-US'
import { zhCN } from './zh-CN'
import { useLocaleStore, type Locale } from './locale-store'

const dictionaries: Record<Locale, Record<TranslationKey, string>> = {
  'en-US': enUS,
  'zh-CN': zhCN,
}

export function translate(locale: Locale, key: TranslationKey, params?: TranslationParams): string {
  let text: string = dictionaries[locale][key] ?? dictionaries['en-US'][key] ?? key
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

export interface Translation {
  readonly locale: Locale
  setLocale(locale: Locale): void
  t(key: TranslationKey, params?: TranslationParams): string
}

/** Binds the dictionary to the active locale; components re-render on switch. */
export function useTranslation(): Translation {
  const locale = useLocaleStore((state) => state.locale)
  const setLocale = useLocaleStore((state) => state.setLocale)
  return {
    locale,
    setLocale,
    t: (key, params) => translate(locale, key, params),
  }
}

/** True when the key exists in the source (en-US) dictionary. */
export function hasTranslationKey(key: string): key is TranslationKey {
  return key in enUS
}

/** Builds a localized transport error for IPC failures outside React components. */
export function transportError(): { code: 'UNKNOWN'; message: string; retryable: true } {
  return {
    code: 'UNKNOWN',
    message: translate(useLocaleStore.getState().locale, 'error.transport'),
    retryable: true,
  }
}

export { LOCALES, useLocaleStore, type Locale } from './locale-store'
export type { TranslationKey, TranslationParams }
