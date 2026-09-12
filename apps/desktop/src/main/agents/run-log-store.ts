import {
  closeSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'

import type { AgentRun, IpcResult } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from '../errors'
import type { TeskraPaths } from '../paths'
import { redactSecrets } from '../redact'

export interface DurableRunEvent {
  readonly seq: number
  readonly eventType: string
  readonly payload: Record<string, unknown>
  readonly createdAt: string
}

export interface RunLogStore {
  initialize(run: AgentRun): IpcResult<void>
  writeRun(run: AgentRun): IpcResult<void>
  appendEvent(
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
    createdAt: string,
  ): IpcResult<DurableRunEvent>
  appendTerminal(runId: string, data: string): IpcResult<void>
  /**
   * P1-6: reads the last `maxBytes` bytes of terminal.log (the whole file when
   * it is smaller). Returns `null` when the file is absent — RetentionService
   * (TASK-069) collects the volatile log files of old terminal runs.
   */
  readTerminalTail(runId: string, maxBytes: number): IpcResult<string | null>
  /** Forces an fsync of the run's dirty log files (lifecycle transitions). */
  flush(runId: string): IpcResult<void>
  /** Flushes and closes the run's log handles; later appends reopen lazily. */
  dispose(runId: string): IpcResult<void>
  /** Flushes and closes every open handle (process shutdown). */
  disposeAll(): IpcResult<void>
}

export interface RunLogStoreDeps {
  readonly paths: TeskraPaths
  /** Millisecond clock — injectable so tests can control the fsync throttle. */
  readonly now?: () => number
  /**
   * Minimum milliseconds between fsyncs of the same log file while dirty.
   * Defaults to 1s — see the durability comment on createRunLogStore.
   */
  readonly fsyncIntervalMs?: number
  /** Injectable fsync (tests count calls); defaults to fsyncSync. */
  readonly fsync?: (fd: number) => void
  /** Injectable append-mode open (tests count calls); defaults to 0o600 'a'. */
  readonly openAppend?: (path: string) => number
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function fileFailure<T>(operation: string, path: string, cause: unknown): IpcResult<T> {
  return fail({
    code: 'UNKNOWN',
    message: 'The durable Agent Run log could not be written.',
    retryable: true,
    detail: `${operation} failed for ${path}`,
    cause,
  })
}

function touch(path: string): void {
  const descriptor = openSync(path, 'a', 0o600)
  closeSync(descriptor)
}

/** Reads `[offset, offset + length)` of a file, looping over short reads. */
function readSlice(path: string, offset: number, length: number): Buffer {
  const descriptor = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const count = readSync(descriptor, buffer, read, length - read, offset + read)
      if (count === 0) break
      read += count
    }
    return read === length ? buffer : buffer.subarray(0, read)
  } finally {
    closeSync(descriptor)
  }
}

let manifestWriteId = 0

function writeJsonAtomically(path: string, value: unknown): void {
  manifestWriteId += 1
  const temporary = `${path}.${String(process.pid)}.${String(manifestWriteId)}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, path)
  } catch (cause) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file may not have been created; preserve the original failure.
    }
    throw cause
  }
}

interface OpenLogFile {
  readonly fd: number
  size: number
  dirty: boolean
  lastFsyncAt: number
}

interface EventLogState {
  readonly bytes: number
  readonly lines: number
}

const DEFAULT_FSYNC_INTERVAL_MS = 1_000

/**
 * TASK-039 durable file authority; every event line is written to the file
 * before SQLite is updated.
 *
 * P1-1 hot-path durability policy (trade-off, crash recovery is a selling
 * point so this is deliberate):
 * - events.jsonl / terminal.log are written through long-lived append-mode
 *   handles instead of open+write+fsync+close per batch.
 * - fsync is throttled to at most once per `fsyncIntervalMs` (default 1s) per
 *   file while dirty. A crash may therefore lose up to ~1s of streamed
 *   output — acceptable because the renderer already received those bytes
 *   over IPC and neither file feeds crash-time state decisions.
 * - Lifecycle transitions (completed / failed / cancelled / interrupted and
 *   shutdown) always force an fsync via `flush` / `dispose` / `disposeAll`,
 *   so the file authority and SQLite can never disagree about a terminal
 *   status. The append-before-SQLite ordering from TASK-039 is unchanged.
 */
export function createRunLogStore(deps: RunLogStoreDeps): RunLogStore {
  const now = deps.now ?? (() => Date.now())
  const fsyncIntervalMs = deps.fsyncIntervalMs ?? DEFAULT_FSYNC_INTERVAL_MS
  const fsync = deps.fsync ?? fsyncSync
  const openAppend = deps.openAppend ?? ((path: string) => openSync(path, 'a', 0o600))
  const nextSequences = new Map<string, number>()
  const handles = new Map<string, OpenLogFile>()
  /** Validated (byte offset, line count) prefix per events.jsonl path. */
  const eventLogStates = new Map<string, EventLogState>()

  const filesFor = (runId: string) => deps.paths.runFiles(runId)

  /**
   * Validates events.jsonl incrementally: once a prefix has been validated
   * (by this store instance), re-validation only parses lines appended after
   * the recorded offset. A file that shrank (rewritten externally) falls back
   * to a full parse. Bytes before the recorded offset are trusted — they were
   * either parsed here or appended through this store's own handle.
   */
  const countAndValidateEvents = (path: string): number => {
    const size = statSync(path).size
    // Validation points are also where an externally modified file is
    // detected — resync the tracked size of a held handle with reality.
    const handle = handles.get(path)
    if (handle !== undefined) handle.size = size
    const prior = eventLogStates.get(path)
    const incremental = prior !== undefined && size >= prior.bytes
    const offset = incremental ? prior.bytes : 0
    const baseLines = incremental ? prior.lines : 0
    if (size === offset) {
      eventLogStates.set(path, { bytes: size, lines: baseLines })
      return baseLines
    }
    const tail = readSlice(path, offset, size - offset)
    if (tail[tail.length - 1] !== 0x0a) {
      throw new Error('events.jsonl ends with an incomplete line')
    }
    const lines = tail.toString('utf8').slice(0, -1).split('\n')
    for (const [index, line] of lines.entries()) {
      const parsed = JSON.parse(line) as { seq?: unknown }
      if (parsed.seq !== baseLines + index + 1) {
        throw new Error(`events.jsonl seq mismatch at line ${String(baseLines + index + 1)}`)
      }
    }
    eventLogStates.set(path, { bytes: size, lines: baseLines + lines.length })
    return baseLines + lines.length
  }

  const obtain = (path: string): OpenLogFile => {
    const existing = handles.get(path)
    if (existing !== undefined) return existing
    const fd = openAppend(path)
    const file: OpenLogFile = { fd, size: fstatSync(fd).size, dirty: false, lastFsyncAt: now() }
    handles.set(path, file)
    return file
  }

  const syncFile = (file: OpenLogFile, force: boolean): void => {
    if (!force && now() - file.lastFsyncAt < fsyncIntervalMs) {
      file.dirty = true
      return
    }
    if (force && !file.dirty) return
    fsync(file.fd)
    file.dirty = false
    file.lastFsyncAt = now()
  }

  const append = (path: string, value: string): number => {
    const file = obtain(path)
    const initialSize = file.size
    try {
      const bytes = Buffer.from(value, 'utf8')
      const written = writeSync(file.fd, bytes, 0, bytes.length)
      if (written !== bytes.length) {
        throw new Error(`short append: wrote ${String(written)} of ${String(bytes.length)} bytes`)
      }
      file.size += written
      syncFile(file, false)
      return file.size
    } catch (cause) {
      ftruncateSync(file.fd, initialSize)
      fsync(file.fd)
      file.size = initialSize
      file.dirty = false
      file.lastFsyncAt = now()
      throw cause
    }
  }

  const syncRun = (runId: string, close: boolean): IpcResult<void> => {
    const files = filesFor(runId)
    if (!files.ok) return files
    try {
      for (const path of [files.data.events, files.data.terminal]) {
        const file = handles.get(path)
        if (file === undefined) continue
        if (file.dirty) syncFile(file, true)
        if (close) {
          closeSync(file.fd)
          handles.delete(path)
        }
      }
      return { ok: true, data: undefined }
    } catch (cause) {
      return fileFailure('log flush', files.data.directory, cause)
    }
  }

  const writeRun = (run: AgentRun): IpcResult<void> => {
    const files = filesFor(run.id)
    if (!files.ok) return files
    try {
      writeJsonAtomically(files.data.manifest, redactSecrets(run))
      return { ok: true, data: undefined }
    } catch (cause) {
      return fileFailure('manifest write', files.data.manifest, cause)
    }
  }

  return {
    initialize(run) {
      const files = filesFor(run.id)
      if (!files.ok) return files
      try {
        touch(files.data.events)
        touch(files.data.terminal)
        touch(files.data.handoff)
        touch(files.data.diff)
        nextSequences.set(run.id, countAndValidateEvents(files.data.events) + 1)
      } catch (cause) {
        return fileFailure('Run directory initialization', files.data.directory, cause)
      }
      return writeRun(run)
    },

    writeRun,

    appendEvent(runId, eventType, payload, createdAt) {
      const files = filesFor(runId)
      if (!files.ok) return files
      try {
        const next = nextSequences.get(runId) ?? countAndValidateEvents(files.data.events) + 1
        const sanitized = redactSecrets(payload) as Record<string, unknown>
        const event: DurableRunEvent = { seq: next, eventType, payload: sanitized, createdAt }
        const size = append(files.data.events, `${JSON.stringify(event)}\n`)
        nextSequences.set(runId, next + 1)
        eventLogStates.set(files.data.events, { bytes: size, lines: next })
        return { ok: true, data: event }
      } catch (cause) {
        return fileFailure('event append', files.data.events, cause)
      }
    },

    appendTerminal(runId, data) {
      const files = filesFor(runId)
      if (!files.ok) return files
      try {
        append(files.data.terminal, redactSecrets(data) as string)
        return { ok: true, data: undefined }
      } catch (cause) {
        return fileFailure('terminal append', files.data.terminal, cause)
      }
    },

    readTerminalTail(runId, maxBytes) {
      const files = filesFor(runId)
      if (!files.ok) return files
      try {
        const size = statSync(files.data.terminal).size
        const length = Math.max(0, Math.min(size, Math.floor(maxBytes)))
        const offset = size - length
        const text = readSlice(files.data.terminal, offset, length).toString('utf8')
        // A tail cut can split a multi-byte UTF-8 character; the decoder marks
        // the partial prefix with U+FFFD — drop it rather than leak mojibake.
        return { ok: true, data: offset > 0 && text.startsWith('�') ? text.slice(1) : text }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
          return { ok: true, data: null }
        }
        return fileFailure('terminal read', files.data.terminal, cause)
      }
    },

    flush: (runId) => syncRun(runId, false),

    dispose(runId) {
      const files = filesFor(runId)
      if (!files.ok) return files
      // P2-4: drop every per-Run cache along with the handles — the Maps are
      // otherwise append-only for the whole app session. A later append for
      // the same run simply revalidates events.jsonl from disk.
      nextSequences.delete(runId)
      eventLogStates.delete(files.data.events)
      return syncRun(runId, true)
    },

    disposeAll() {
      try {
        for (const [path, file] of [...handles]) {
          if (file.dirty) syncFile(file, true)
          closeSync(file.fd)
          handles.delete(path)
        }
        nextSequences.clear()
        eventLogStates.clear()
        return { ok: true, data: undefined }
      } catch (cause) {
        return fileFailure('log shutdown flush', deps.paths.home(), cause)
      }
    },
  }
}
