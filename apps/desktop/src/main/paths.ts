import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'

import type { IpcResult } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from './errors'

/** The single directory name every Teskra data root is built from. */
export const TESKRA_DATA_DIR = '.teskra'

/**
 * Milestone 24 (design doc §9): per-runtime root for Agent account profile
 * homes, directly under the data root. The runtime is NOT a path segment —
 * it selects which data root applies (§9.1).
 */
export const AGENT_PROFILES_DIR = 'agent-profiles'

export interface RunPaths {
  readonly directory: string
  readonly manifest: string
  readonly events: string
  readonly terminal: string
  readonly handoff: string
  readonly diff: string
  readonly artifacts: string
  /** ADR-0012 / TASK-126: append-only Agent progress file (never pre-created). */
  readonly progress: string
}

/** File names inside a run directory; the single source for both writers and GC. */
const RUN_FILE_NAMES = {
  manifest: 'run.json',
  events: 'events.jsonl',
  terminal: 'terminal.log',
  handoff: 'handoff.json',
  diff: 'diff.patch',
  artifacts: 'artifacts',
  progress: 'progress.jsonl',
} as const

/** The volatile log files RetentionService (TASK-069) may collect. */
export interface RunLogFiles {
  readonly events: string
  readonly terminal: string
  readonly progress: string
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
  /**
   * Volatile log files inside an EXISTING run directory (TASK-069) —
   * resolution only, no I/O, so GC can probe without recreating directories.
   */
  runLogFiles(runDirectory: string): RunLogFiles
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
  /**
   * <home>/agent-profiles (Milestone 24 §9.1) — the host-side trusted root
   * for Agent account profile homes. Resolution only, no I/O.
   */
  agentProfilesRoot(): string
  /**
   * <home>/agent-profiles/<agentId>/<slug> (§9.1 / §9.2) — PURE resolution,
   * never touches the filesystem, so the Manager can INSERT first (unique
   * index blocks concurrent creation) and only then create the directory.
   */
  resolveAgentProfileHome(agentId: string, slug: string): IpcResult<string>
  /**
   * Creates a previously resolved profile home (§9.2: only AFTER the INSERT
   * succeeded). The absolute path must come from resolveAgentProfileHome;
   * anything outside agentProfilesRoot() is rejected (defense in depth).
   */
  createAgentProfileHome(absolutePath: string): IpcResult<void>
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
export function isValidPathSegment(value: string): boolean {
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
    if (!isValidPathSegment(runId)) {
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
    runLogFiles(runDirectory) {
      return {
        events: join(runDirectory, RUN_FILE_NAMES.events),
        terminal: join(runDirectory, RUN_FILE_NAMES.terminal),
        progress: join(runDirectory, RUN_FILE_NAMES.progress),
      }
    },
    runFiles(runId) {
      const directory = runDir(runId)
      if (!directory.ok) return directory
      const artifacts = ensureDir(join(directory.data, RUN_FILE_NAMES.artifacts))
      if (!artifacts.ok) return artifacts
      return {
        ok: true,
        data: {
          directory: directory.data,
          manifest: join(directory.data, RUN_FILE_NAMES.manifest),
          events: join(directory.data, RUN_FILE_NAMES.events),
          terminal: join(directory.data, RUN_FILE_NAMES.terminal),
          handoff: join(directory.data, RUN_FILE_NAMES.handoff),
          diff: join(directory.data, RUN_FILE_NAMES.diff),
          artifacts: artifacts.data,
          progress: join(directory.data, RUN_FILE_NAMES.progress),
        },
      }
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
    agentProfilesRoot() {
      return join(home(), AGENT_PROFILES_DIR)
    },
    resolveAgentProfileHome(agentId, slug) {
      if (!isValidPathSegment(agentId)) {
        return { ok: false, error: toPublicError(invalidSegmentError('agentId', agentId)) }
      }
      if (!isValidPathSegment(slug)) {
        return { ok: false, error: toPublicError(invalidSegmentError('slug', slug)) }
      }
      return { ok: true, data: join(home(), AGENT_PROFILES_DIR, agentId, slug) }
    },
    createAgentProfileHome(absolutePath) {
      // §9.2 defense in depth: only ever create homes UNDER the
      // agent-profiles root — never the root itself, never anywhere else,
      // even if a caller hands over an arbitrary absolute path.
      const root = join(home(), AGENT_PROFILES_DIR)
      const contained = isAbsolute(absolutePath) ? relative(root, absolutePath) : '..'
      if (
        contained === '' ||
        contained === '..' ||
        contained.startsWith(`..${sep}`) ||
        isAbsolute(contained)
      ) {
        return {
          ok: false,
          error: toPublicError({
            code: 'VALIDATION_FAILED',
            message: 'The profile home must be inside the Teskra agent-profiles directory.',
            retryable: false,
            detail: `createAgentProfileHome rejected ${absolutePath} (root ${root})`,
          }),
        }
      }
      const created = ensureDir(absolutePath)
      return created.ok ? { ok: true, data: undefined } : created
    },
  }
}
