import { Alert } from 'antd'

import type { ErrorCode, PublicAppError } from '@teskra/contracts'

const suggestions: Record<ErrorCode, string> = {
  WORKSPACE_NOT_FOUND: 'Check that the folder still exists and that its runtime is available.',
  WSL_NOT_AVAILABLE: 'Install or start WSL, then retry the operation.',
  WSL_DISTRO_NOT_FOUND: 'Choose an installed distribution in Settings → Environment.',
  AGENT_NOT_INSTALLED: 'Install the Agent CLI or configure its executable in Settings.',
  CAPABILITY_NOT_AVAILABLE: 'This capability is not available in the current runtime.',
  COMMAND_TIMEOUT: 'Retry, or inspect the logs if the command continues to time out.',
  PROCESS_NOT_FOUND: 'The process has already exited. Refresh the active session.',
  TERMINAL_NOT_FOUND: 'The terminal has already closed. Open a new terminal.',
  MERGE_BLOCKED: 'Resolve the reported Git conflicts before retrying.',
  VALIDATION_FAILED: 'Review the entered values and try again.',
  UNKNOWN: 'Retry the operation. If it persists, open the logs from Settings → Advanced.',
}

export function suggestionFor(code: ErrorCode): string {
  return suggestions[code]
}

interface AppErrorAlertProps {
  readonly error: PublicAppError
  readonly onClose?: () => void
  readonly className?: string
}

/** Renders only the public error contract; internal detail/cause cannot reach this component. */
export function AppErrorAlert({ error, onClose, className }: AppErrorAlertProps) {
  return (
    <Alert
      className={className}
      type="error"
      showIcon
      closable={onClose !== undefined}
      message={error.message}
      description={suggestionFor(error.code)}
      onClose={onClose}
    />
  )
}
