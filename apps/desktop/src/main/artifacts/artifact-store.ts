import { randomUUID } from 'node:crypto'
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

import type {
  Artifact,
  ArtifactContent,
  ArtifactIdRequest,
  ArtifactType,
  IpcResult,
  ListArtifactsRequest,
  RecordArtifactRequest,
  ScanRunArtifactsRequest,
  WorkbenchEvents,
} from '@teskra/contracts'

import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { ArtifactRepository } from '../db/repositories/artifact-repository'
import type { TaskRepository } from '../db/repositories/task-repository'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import type { TeskraPaths } from '../paths'

/** File payloads larger than this are cut off and flagged `truncated`. */
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024

/**
 * ArtifactStore (TASK-050) — the Artifact domain service.
 *
 * An Artifact is attached to a Task and optionally to the Run that produced
 * it. Its payload is exactly one of three forms (enforced by
 * `recordArtifactRequestSchema`):
 *
 * - inline text stored in `artifacts.content`;
 * - a file path relative to the owning Run's artifact directory
 *   (`paths.runFiles(runId).artifacts`, ADR-0004). Paths are validated to
 *   stay inside that directory both at record time and at read time;
 * - a metadata JSON record.
 *
 * `get` resolves any form into displayable text; file payloads are capped at
 * `maxFileBytes` and flagged `truncated` when cut off.
 *
 * `scanRun` discovers files an Agent dropped into its artifact directory
 * (ADR-0004 `TESKRA_ARTIFACT_DIR`) and registers the ones not indexed yet.
 */
export interface ArtifactStore {
  record(request: RecordArtifactRequest): IpcResult<Artifact>
  list(request: ListArtifactsRequest): IpcResult<Artifact[]>
  get(request: ArtifactIdRequest): IpcResult<ArtifactContent | null>
  scanRun(request: ScanRunArtifactsRequest): IpcResult<Artifact[]>
}

export interface ArtifactStoreDeps {
  readonly artifacts: ArtifactRepository
  readonly tasks: TaskRepository
  readonly runs: AgentRunRepository
  readonly events: EventBus<WorkbenchEvents>
  readonly paths: TeskraPaths
  readonly createId?: () => string
  readonly now?: () => string
  readonly maxFileBytes?: number
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function invalid<T>(message: string, detail: string): IpcResult<T> {
  return fail({ code: 'VALIDATION_FAILED', message, retryable: false, detail })
}

/** Windows absolute forms that node:path.isAbsolute misses on POSIX hosts. */
const WINDOWS_ABSOLUTE_PATTERN = /^([A-Za-z]:[\\/]|\\\\)/u

/**
 * Absolute paths and `..` escapes must never leave the artifact directory.
 * Both separator families are rejected explicitly: agents may hand us a
 * Windows-shaped path (`..\evil`, `C:\…`) while the host resolves POSIX-style
 * (or vice versa), so platform-local isAbsolute/resolve alone is not enough.
 */
export function resolveArtifactPath(artifactDir: string, filePath: string): string | undefined {
  if (isAbsolute(filePath) || filePath.startsWith('/') || WINDOWS_ABSOLUTE_PATTERN.test(filePath)) {
    return undefined
  }
  if (filePath.split(/[\\/]/u).includes('..')) {
    return undefined
  }
  const base = resolve(artifactDir)
  const resolved = resolve(base, filePath)
  return resolved === base || resolved.startsWith(base + sep) ? resolved : undefined
}

function guessArtifactType(fileName: string): ArtifactType {
  const name = fileName.toLowerCase()
  if (name.includes('plan')) return 'plan'
  if (name.includes('review')) return 'review'
  if (name.includes('test')) return 'test-result'
  if (name.includes('diff') || name.endsWith('.patch')) return 'diff'
  if (name.includes('decision')) return 'decision'
  if (name.includes('handoff')) return 'handoff'
  return 'implementation'
}

export function createArtifactStore(deps: ArtifactStoreDeps): ArtifactStore {
  const createId = deps.createId ?? randomUUID
  const now = deps.now ?? (() => new Date().toISOString())
  const maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES

  const artifactDir = (runId: string): IpcResult<string> => {
    const files = deps.paths.runFiles(runId)
    return files.ok ? { ok: true, data: files.data.artifacts } : files
  }

  /** Validates a stored `file_path` against its Run's artifact directory. */
  const resolveStoredFile = (artifact: Artifact): IpcResult<string> => {
    if (artifact.runId === undefined) {
      return invalid(
        `Artifact "${artifact.id}" references a file but is no longer attached to a Run.`,
        `artifact id=${JSON.stringify(artifact.id)} has filePath but runId is unset`,
      )
    }
    const directory = artifactDir(artifact.runId)
    if (!directory.ok) return directory
    const resolved = resolveArtifactPath(directory.data, artifact.filePath ?? '')
    if (resolved === undefined) {
      return invalid(
        'The artifact file path escapes the Run artifact directory.',
        `artifact id=${JSON.stringify(artifact.id)} filePath=${JSON.stringify(artifact.filePath)} artifactDir=${directory.data}`,
      )
    }
    // The lexical check above cannot see symlinks: an Agent can drop a symlink
    // inside its own artifact directory that points anywhere on the host, and
    // stat/read would follow it. Compare real paths so the resolved target
    // must stay inside the real artifact directory.
    let realDirectory: string
    let realTarget: string
    try {
      realDirectory = realpathSync(directory.data)
      realTarget = realpathSync(resolved)
    } catch {
      // A missing file is reported by the read step with its own error.
      return { ok: true, data: resolved }
    }
    if (realTarget !== realDirectory && !realTarget.startsWith(realDirectory + sep)) {
      return invalid(
        'The artifact file path escapes the Run artifact directory.',
        `artifact id=${JSON.stringify(artifact.id)} filePath=${JSON.stringify(artifact.filePath)} resolves to ${realTarget}, outside ${realDirectory}`,
      )
    }
    return { ok: true, data: resolved }
  }

  const readFileContent = (path: string): IpcResult<{ content: string; truncated: boolean }> => {
    try {
      const size = statSync(path).size
      if (size <= maxFileBytes) {
        return { ok: true, data: { content: readFileSync(path, 'utf8'), truncated: false } }
      }
      const buffer = Buffer.alloc(maxFileBytes)
      const handle = openSync(path, 'r')
      try {
        readSync(handle, buffer, 0, maxFileBytes, 0)
      } finally {
        closeSync(handle)
      }
      return { ok: true, data: { content: buffer.toString('utf8'), truncated: true } }
    } catch (cause) {
      return fail({
        code: 'UNKNOWN',
        message: 'The artifact file could not be read.',
        retryable: true,
        detail: `read failed for ${path}`,
        cause,
      })
    }
  }

  return {
    record(request) {
      const task = deps.tasks.getById(request.taskId)
      if (!task.ok) return task
      if (task.data === null) {
        return invalid(
          `Task "${request.taskId}" was not found.`,
          `ArtifactStore could not resolve task id=${JSON.stringify(request.taskId)}`,
        )
      }
      if (request.runId !== undefined) {
        const run = deps.runs.getById(request.runId)
        if (!run.ok) return run
        if (run.data === null) {
          return invalid(
            `Agent run "${request.runId}" was not found.`,
            `ArtifactStore could not resolve agent run id=${JSON.stringify(request.runId)}`,
          )
        }
        if (run.data.taskId !== undefined && run.data.taskId !== request.taskId) {
          return invalid(
            `Run "${request.runId}" belongs to a different Task.`,
            `run id=${JSON.stringify(request.runId)} taskId=${JSON.stringify(run.data.taskId)} != artifact taskId=${JSON.stringify(request.taskId)}`,
          )
        }
      }
      if (request.filePath !== undefined) {
        if (request.runId === undefined) {
          return invalid(
            'A file artifact must be attached to the Run that owns the file.',
            `artifact name=${JSON.stringify(request.name)} has filePath without runId`,
          )
        }
        const directory = artifactDir(request.runId)
        if (!directory.ok) return directory
        if (resolveArtifactPath(directory.data, request.filePath) === undefined) {
          return invalid(
            'The artifact file path escapes the Run artifact directory.',
            `artifact name=${JSON.stringify(request.name)} filePath=${JSON.stringify(request.filePath)} artifactDir=${directory.data}`,
          )
        }
      }
      const created = deps.artifacts.create(
        {
          id: createId(),
          taskId: request.taskId,
          type: request.type,
          name: request.name,
          ...(request.runId === undefined ? {} : { runId: request.runId }),
          ...(request.content === undefined ? {} : { content: request.content }),
          ...(request.filePath === undefined ? {} : { filePath: request.filePath }),
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        },
        now(),
      )
      if (created.ok) deps.events.emit('task.updated', { taskId: request.taskId })
      return created
    },

    list(request) {
      if (request.taskId !== undefined) {
        const listed = deps.artifacts.listByTask(request.taskId, request.type)
        if (!listed.ok) return listed
        return request.runId === undefined
          ? listed
          : { ok: true, data: listed.data.filter(({ runId }) => runId === request.runId) }
      }
      if (request.runId === undefined) {
        return invalid('taskId or runId is required.', 'list called without taskId and runId')
      }
      const listed = deps.artifacts.listByRun(request.runId)
      if (!listed.ok) return listed
      return request.type === undefined
        ? listed
        : { ok: true, data: listed.data.filter(({ type }) => type === request.type) }
    },

    get({ artifactId }) {
      const found = deps.artifacts.getById(artifactId)
      if (!found.ok) return found
      if (found.data === null) return { ok: true, data: null }
      const artifact = found.data
      if (artifact.content !== undefined) {
        return { ok: true, data: { artifact, content: artifact.content, truncated: false } }
      }
      if (artifact.metadata !== undefined) {
        return {
          ok: true,
          data: { artifact, content: JSON.stringify(artifact.metadata, null, 2), truncated: false },
        }
      }
      if (artifact.filePath !== undefined) {
        const resolved = resolveStoredFile(artifact)
        if (!resolved.ok) return resolved
        const read = readFileContent(resolved.data)
        if (!read.ok) return read
        return { ok: true, data: { artifact, ...read.data } }
      }
      return { ok: true, data: { artifact, content: '', truncated: false } }
    },

    scanRun({ runId }) {
      const run = deps.runs.getById(runId)
      if (!run.ok) return run
      if (run.data === null) {
        return invalid(
          `Agent run "${runId}" was not found.`,
          `ArtifactStore could not resolve agent run id=${JSON.stringify(runId)}`,
        )
      }
      if (run.data.taskId === undefined) {
        return invalid(
          `Run "${runId}" is not attached to a Task; its artifacts cannot be indexed.`,
          `agent run id=${JSON.stringify(runId)} has no taskId`,
        )
      }
      const taskId = run.data.taskId
      const directory = artifactDir(runId)
      if (!directory.ok) return directory
      const existing = deps.artifacts.listByRun(runId)
      if (!existing.ok) return existing
      const indexed = new Set(
        existing.data.flatMap(({ filePath }) => (filePath === undefined ? [] : [filePath])),
      )
      let entries: string[]
      try {
        entries = readdirSync(directory.data, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort()
      } catch (cause) {
        return fail({
          code: 'UNKNOWN',
          message: 'The Run artifact directory could not be scanned.',
          retryable: true,
          detail: `readdir failed for ${directory.data}`,
          cause,
        })
      }
      for (const name of entries) {
        if (indexed.has(name)) continue
        const created = deps.artifacts.create(
          { id: createId(), taskId, runId, type: guessArtifactType(name), name, filePath: name },
          now(),
        )
        if (!created.ok) return created
      }
      if (entries.some((name) => !indexed.has(name))) {
        deps.events.emit('task.updated', { taskId })
      }
      return deps.artifacts.listByRun(runId)
    },
  }
}
