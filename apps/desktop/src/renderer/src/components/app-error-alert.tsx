import { Alert } from 'antd'

import type { ErrorCode, PublicAppError } from '@teskra/contracts'

import {
  hasTranslationKey,
  useTranslation,
  type TranslationKey,
  type TranslationParams,
} from '../i18n'

export type Translate = (key: TranslationKey, params?: TranslationParams) => string

export function suggestionFor(code: ErrorCode, t: Translate): string {
  return t(`errorSuggestion.${code}`)
}

// A leftover "{name}" placeholder after interpolation means the params Main
// sent did not cover the dictionary template — showing it would leak template
// syntax, so fall back to the English message instead.
const UNRESOLVED_PARAM = /\{[a-zA-Z][a-zA-Z0-9]*\}/

/**
 * Resolves the alert title: the localized dictionary entry when the error
 * carries a known `messageKey`, otherwise the English `message` fallback.
 * Never throws — any resolution failure degrades to `error.message`.
 */
export function resolveErrorMessage(error: PublicAppError, t: Translate): string {
  const { messageKey, params } = error
  if (messageKey === undefined || !hasTranslationKey(messageKey)) {
    return error.message
  }
  try {
    const resolved = t(messageKey, params)
    return UNRESOLVED_PARAM.test(resolved) ? error.message : resolved
  } catch {
    return error.message
  }
}

interface AppErrorAlertProps {
  readonly error: PublicAppError
  readonly onClose?: () => void
  readonly className?: string
}

/** Renders only the public error contract; internal detail/cause cannot reach this component. */
export function AppErrorAlert({ error, onClose, className }: AppErrorAlertProps) {
  const { t } = useTranslation()
  return (
    <Alert
      {...(className === undefined ? {} : { className })}
      type="error"
      showIcon
      closable={onClose !== undefined}
      message={resolveErrorMessage(error, t)}
      description={suggestionFor(error.code, t)}
      {...(onClose === undefined ? {} : { onClose })}
    />
  )
}
