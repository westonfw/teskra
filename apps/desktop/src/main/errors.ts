import { randomUUID } from 'node:crypto'

import type { ErrorCode, PublicAppError } from '@teskra/contracts'

/**
 * Unified error model, Main side (teskra-tasks.md §0 / TASK-003).
 *
 * `InternalAppError` only circulates inside the Main process and never crosses
 * IPC — that is why it lives here and NOT in @teskra/contracts. The only way
 * out is `toPublicError`, which strips `detail` / `cause` and logs them.
 */
export interface InternalAppError {
  code: ErrorCode
  /** User-facing message, safe to display. Fallback when messageKey cannot be resolved. */
  message: string
  retryable: boolean
  /**
   * Renderer dictionary key (`errorMessage.*` in en-US / zh-CN). New
   * user-facing errors SHOULD set this so localized UIs can translate the
   * message; every key used in src/main is asserted against both dictionaries
   * by src/error-message-keys.test.ts, so adding a key without dictionary
   * entries fails the test suite.
   */
  messageKey?: string
  /** Interpolation params for messageKey — string/number values only. */
  params?: Record<string, string | number>
  /** Paths, command lines, stderr — log only, never sent to the Renderer. */
  detail?: string
  /** Original exception — log only, never sent to the Renderer. */
  cause?: unknown
}

export interface AppErrorLogger {
  error(record: Record<string, unknown>, message: string): void
}

// TASK-004 (unified pino logging) will call setErrorLogger() at startup.
let errorLogger: AppErrorLogger | undefined

export function setErrorLogger(logger: AppErrorLogger): void {
  errorLogger = logger
}

function serializeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message, stack: cause.stack }
  }
  return cause
}

/** The single conversion exit. Never throws; unclassifiable input → UNKNOWN. */
export function toPublicError(error: InternalAppError, correlationId?: string): PublicAppError {
  errorLogger?.error(
    {
      // TASK-004: every logged error carries a correlationId; callers may
      // supply their own to tie an error to an in-flight operation.
      correlationId: correlationId ?? randomUUID(),
      code: error.code,
      detail: error.detail,
      cause: serializeCause(error.cause),
    },
    error.message,
  )
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    // Optional i18n fields are only attached when present, so errors without
    // a messageKey keep the exact legacy shape over IPC.
    ...(error.messageKey === undefined ? {} : { messageKey: error.messageKey }),
    ...(error.params === undefined ? {} : { params: error.params }),
  }
}
