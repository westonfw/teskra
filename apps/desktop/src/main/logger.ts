import { join } from 'node:path'

import pino, { type Logger, type LoggerOptions } from 'pino'

import type { IpcResult } from '@teskra/contracts'

import { setErrorLogger } from './errors'
import type { TeskraPaths } from './paths'
import { redactSecrets } from './redact'

/**
 * Unified logging (TASK-004). One pino logger per scope, writing
 * `<home>/logs/<scope>.log` (directory resolved through TASK-078 paths).
 * Every record carries timestamp / level / scope, and all log arguments pass
 * through `redactSecrets` before serialization so secrets never hit disk.
 *
 * Main process only — the sandboxed preload never touches pino.
 */
export const LOG_SCOPES = ['app', 'runtime', 'agent', 'process', 'ipc', 'git', 'security', 'memory'] as const
export type LogScope = (typeof LOG_SCOPES)[number]

export interface LoggerFactoryOptions {
  /** Synchronous writes; used by tests to make file content deterministic. */
  sync?: boolean
}

function baseOptions(): LoggerOptions {
  return {
    level: process.env['TESKRA_LOG_LEVEL'] ?? 'info',
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    hooks: {
      logMethod(args, method) {
        const redacted = args.map((arg) => redactSecrets(arg))
        ;(method as (...a: unknown[]) => void).apply(this, redacted)
      },
    },
  }
}

/** Creates a scope logger writing to `<directory>/<scope>.log`. */
export function createScopeLogger(
  scope: LogScope,
  directory: string,
  options: LoggerFactoryOptions = {},
): Logger {
  const destination = pino.destination({
    dest: join(directory, `${scope}.log`),
    mkdir: true,
    sync: options.sync ?? false,
  })
  return pino(baseOptions(), destination).child({ scope })
}

let logDirectory: string | undefined
const scopeLoggers = new Map<LogScope, Logger>()

/**
 * Resolves the log directory through the paths module, arms the per-scope
 * file loggers, and wires TASK-003's setErrorLogger so toPublicError() writes
 * detail / cause (with correlationId) into the app log. On failure the
 * structured error is returned and logging falls back to stdout.
 */
export function initializeLogging(
  paths: TeskraPaths,
  options: LoggerFactoryOptions = {},
): IpcResult<string> {
  const result = paths.logs()
  if (!result.ok) {
    return result
  }
  logDirectory = result.data
  scopeLoggers.clear()
  for (const scope of LOG_SCOPES) {
    scopeLoggers.set(scope, createScopeLogger(scope, logDirectory, options))
  }
  setErrorLogger({
    error: (record, message) => {
      getLogger('app').error(record, message)
    },
  })
  return { ok: true, data: logDirectory }
}

/**
 * Returns the scope logger. Before initializeLogging() (or after its failure)
 * logs go to stdout instead of a file — never silently dropped.
 */
export function getLogger(scope: LogScope): Logger {
  let logger = scopeLoggers.get(scope)
  if (!logger) {
    logger = pino(baseOptions()).child({ scope })
    scopeLoggers.set(scope, logger)
  }
  return logger
}

/**
 * Facade capability for the Settings UI (mounted by TASK-093): where the log
 * files live. Undefined until initializeLogging() succeeded.
 */
export function getLogDirectory(): string | undefined {
  return logDirectory
}

/** Test-only: reset module state so suites can re-initialize with a temp home. */
export function resetLoggingStateForTests(): void {
  logDirectory = undefined
  scopeLoggers.clear()
}
