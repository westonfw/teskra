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
  /** User-facing message, safe to display. */
  message: string
  retryable: boolean
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
  return { code: error.code, message: error.message, retryable: error.retryable }
}
