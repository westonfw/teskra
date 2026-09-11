import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { IpcResult } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from './errors'

/** The single directory name every Teskra data root is built from. */
export const TESKRA_DATA_DIR = '.teskra'

export interface RunPaths {
  readonly directory: string
  readonly manifest: string
  readonly events: string
  readonly terminal: string
  readonly handoff: string
  readonly diff: string
  readonly artifacts: string
}

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
  /** Every durable path owned by one Agent Run; creates the artifacts directory. */
  runFiles(runId: string): IpcResult<RunPaths>
  /** <home>/worktrees/<workspaceId>/ — created on demand. */
  worktreeRoot(workspaceId: string): IpcResult<string>
  /** <home>/config.json — resolution only; the file may not exist. */
  config(): string
  /**
   * <home>/credentials.json (TASK-088 Credential Store, plan §60) — resolution
   * only, no I/O. Holds cipher-encrypted secrets only, never plaintext.
   */
  credentials(): string
  /**
   * <repoRoot>/.teskra/config.json (ADR-0003 repo-local config, TASK-080) —
   * resolution only, no I/O. Uses host path semantics; reading a WSL-side
   * repo from a Windows host is the WorkspaceRuntime's future concern, so a
   * non-native repoRoot simply yields a path that will not exist on the host.
   */
  repoConfig(repoRoot: string): string
  /**
   * <repoRoot>/.teskra/prompts/ (TASK-079 repo-local prompt template
   * overrides) — resolution only, no I/O. Same host-path caveat as
   * repoConfig().
   */
  repoPromptsDir(repoRoot: string): string
  /**
   * <repoRoot>/.teskra/memory/ (TASK-067 repo-local Workspace Memory,
   * plan §45) — resolution only, no I/O. Same host-path caveat as
   * repoConfig().
   */
  repoMemoryDir(repoRoot: string): string
  /**
   * <repoRoot>/.teskra/workflows/ (ADR-0005 repo-local Workflow definitions,
   * TASK-055) — resolution only, no I/O. Same host-path caveat as
   * repoConfig().
   */
  repoWorkflowsDir(repoRoot: string): string
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

  const runDir = (runId: string): IpcResult<string> => {
    if (!isValidSegment(runId)) {
      return { ok: false, error: toPublicError(invalidSegmentError('runId', runId)) }
    }
    return ensureDir(join(home(), 'runs', runId))
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
    runDir,
    runFiles(runId) {
      const directory = runDir(runId)
      if (!directory.ok) return directory
      const artifacts = ensureDir(join(directory.data, 'artifacts'))
      if (!artifacts.ok) return artifacts
      return {
        ok: true,
        data: {
          directory: directory.data,
          manifest: join(directory.data, 'run.json'),
          events: join(directory.data, 'events.jsonl'),
          terminal: join(directory.data, 'terminal.log'),
          handoff: join(directory.data, 'handoff.json'),
          diff: join(directory.data, 'diff.patch'),
          artifacts: artifacts.data,
        },
      }
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
    credentials() {
      return join(home(), 'credentials.json')
    },
    repoConfig(repoRoot: string) {
      return join(repoRoot, TESKRA_DATA_DIR, 'config.json')
    },
    repoPromptsDir(repoRoot: string) {
      return join(repoRoot, TESKRA_DATA_DIR, 'prompts')
    },
    repoMemoryDir(repoRoot: string) {
      return join(repoRoot, TESKRA_DATA_DIR, 'memory')
    },
    repoWorkflowsDir(repoRoot: string) {
      return join(repoRoot, TESKRA_DATA_DIR, 'workflows')
    },
  }
}
