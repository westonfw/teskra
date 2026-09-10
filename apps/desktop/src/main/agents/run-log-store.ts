import {
  closeSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
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
}

export interface RunLogStoreDeps {
  readonly paths: TeskraPaths
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

function appendAndFlush(path: string, value: string): void {
  const descriptor = openSync(path, 'a', 0o600)
  const initialSize = fstatSync(descriptor).size
  try {
    const bytes = Buffer.from(value, 'utf8')
    const written = writeSync(descriptor, bytes, 0, bytes.length)
    if (written !== bytes.length) {
      throw new Error(`short append: wrote ${String(written)} of ${String(bytes.length)} bytes`)
    }
    fsyncSync(descriptor)
  } catch (cause) {
    ftruncateSync(descriptor, initialSize)
    fsyncSync(descriptor)
    throw cause
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

function countAndValidateEvents(path: string): number {
  const content = readFileSync(path, 'utf8')
  if (content.length === 0) return 0
  if (!content.endsWith('\n')) throw new Error('events.jsonl ends with an incomplete line')
  const lines = content.slice(0, -1).split('\n')
  for (const [index, line] of lines.entries()) {
    const parsed = JSON.parse(line) as { seq?: unknown }
    if (parsed.seq !== index + 1) {
      throw new Error(`events.jsonl seq mismatch at line ${String(index + 1)}`)
    }
  }
  return lines.length
}

/** TASK-039 durable file authority; every event line is flushed before SQLite is updated. */
export function createRunLogStore(deps: RunLogStoreDeps): RunLogStore {
  const nextSequences = new Map<string, number>()

  const filesFor = (runId: string) => deps.paths.runFiles(runId)

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
        appendAndFlush(files.data.events, `${JSON.stringify(event)}\n`)
        nextSequences.set(runId, next + 1)
        return { ok: true, data: event }
      } catch (cause) {
        return fileFailure('event append', files.data.events, cause)
      }
    },

    appendTerminal(runId, data) {
      const files = filesFor(runId)
      if (!files.ok) return files
      try {
        appendAndFlush(files.data.terminal, redactSecrets(data) as string)
        return { ok: true, data: undefined }
      } catch (cause) {
        return fileFailure('terminal append', files.data.terminal, cause)
      }
    },
  }
}
