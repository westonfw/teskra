import { Alert } from 'antd'

import type { ErrorCode, PublicAppError } from '@teskra/contracts'

import { useTranslation, type TranslationKey } from '../i18n'

export type Translate = (key: TranslationKey) => string

export function suggestionFor(code: ErrorCode, t: Translate): string {
  return t(`errorSuggestion.${code}`)
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
      className={className}
      type="error"
      showIcon
      closable={onClose !== undefined}
      message={error.message}
      description={suggestionFor(error.code, t)}
      onClose={onClose}
    />
  )
}
