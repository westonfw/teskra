import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { IpcResult } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from './errors'

/** The single directory name every Teskra data root is built from. */
export const TESKRA_DATA_DIR = '.teskra'

/**
 * Central path resolution for the Teskra data root (ADR-0003 / TASK-078).
 *
 * Every persistent path comes from this module — no module may hand-build
 * `~/.teskra` paths itself (enforced by an ESLint no-restricted-syntax rule
 * on the ".teskra" literal). `app.getPath("userData")` is deliberately NOT
 * used: on Windows it resolves to `%APPDATA%\Teskra`, not `~/.teskra`.
 *
 * This module only touches node:fs / node:os / node:path and never imports
 * electron, so the Runtime layer can reuse it directly. WSL workspaces get
 * their data root from `WorkspaceRuntime.resolveDataRoot()` (TASK-010);
 * this module is responsible for the Windows/host side only.
 */
export interface TeskraPaths {
  /** TESKRA_HOME ?? <os.homedir()>/.teskra — resolution only, no I/O. */
  home(): string
  /** <home>/db/teskra.sqlite — creates <home>/db on demand. */
  db(): IpcResult<string>
  /** <home>/logs — created on demand. */
  logs(): IpcResult<string>
  /** <home>/runs/<runId> — created on demand. */
  runDir(runId: string): IpcResult<string>
  /** <home>/worktrees/<workspaceId>/ — created on demand. */
  worktreeRoot(workspaceId: string): IpcResult<string>
  /** <home>/config.json — resolution only; the file may not exist. */
  config(): string
}

function invalidSegmentError(kind: string, value: string): InternalAppError {
  return {
    code: 'VALIDATION_FAILED',
    message: `Invalid ${kind}.`,
    retryable: false,
    detail: `${kind} must be a single non-empty path segment, got ${JSON.stringify(value)}`,
  }
}

function mkdirFailedError(path: string, cause: unknown): InternalAppError {
  return {
    code: 'UNKNOWN',
    message: 'Failed to create the Teskra data directory.',
    retryable: false,
    detail: `mkdir failed for ${path}`,
    cause,
  }
}

/** A path segment must not be empty, "." / "..", or contain separators. */
function isValidSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !/[/\\]/.test(value)
}

export function createTeskraPaths(env: NodeJS.ProcessEnv = process.env): TeskraPaths {
  const home = (): string => {
    const override = env['TESKRA_HOME']
    return override && override.length > 0 ? override : join(homedir(), TESKRA_DATA_DIR)
  }

  const ensureDir = (dir: string): IpcResult<string> => {
    try {
      mkdirSync(dir, { recursive: true })
      return { ok: true, data: dir }
    } catch (cause) {
      return { ok: false, error: toPublicError(mkdirFailedError(dir, cause)) }
    }
  }

  return {
    home,
    db() {
      const result = ensureDir(join(home(), 'db'))
      return result.ok ? { ok: true, data: join(result.data, 'teskra.sqlite') } : result
    },
    logs() {
      return ensureDir(join(home(), 'logs'))
    },
    runDir(runId: string) {
      if (!isValidSegment(runId)) {
        return { ok: false, error: toPublicError(invalidSegmentError('runId', runId)) }
      }
      return ensureDir(join(home(), 'runs', runId))
    },
    worktreeRoot(workspaceId: string) {
      if (!isValidSegment(workspaceId)) {
        return { ok: false, error: toPublicError(invalidSegmentError('workspaceId', workspaceId)) }
      }
      return ensureDir(join(home(), 'worktrees', workspaceId))
    },
    config() {
      return join(home(), 'config.json')
    },
  }
}
