import { closeSync, openSync, readSync, statSync } from 'node:fs'

import {
  agentProgressEventSchema,
  LIST_AGENT_PROGRESS_DEFAULT_LIMIT,
  type AgentProgressEvent,
  type AgentProgressRecord,
  type IpcResult,
  type ListAgentProgressRequest,
  type WorkbenchEvents,
} from '@teskra/contracts'

import type { AgentEventRepository } from '../db/repositories/agent-event-repository'
import type { EventBus } from '../events/event-bus'
import { getLogger } from '../logger'
import type { TeskraPaths } from '../paths'
import { redactSecrets } from '../redact'
import type { RunLogStore } from './run-log-store'
import type { RunWatchdogService } from './run-watchdog-service'

/** ADR-0012 §3: 1s polling — fs.watch is unreliable across the WSL boundary. */
export const PROGRESS_POLL_INTERVAL_MS = 1_000
/** ADR-0012 §4: a single line beyond this is skipped (and counted bad). */
export const PROGRESS_MAX_LINE_BYTES = 8 * 1024
/** ADR-0012 §4: a file beyond this stops the follower (progress_summary). */
export const PROGRESS_MAX_FILE_BYTES = 4 * 1024 * 1024

const PROGRESS_EVENT_TYPE = 'agent.progress'

export interface ProgressFollowerDeps {
  readonly paths: TeskraPaths
  readonly runLogs: Pick<RunLogStore, 'appendEvent'>
  readonly agentEvents: Pick<AgentEventRepository, 'append' | 'listByRunAndType'>
  readonly events: EventBus<WorkbenchEvents>
  /** TASK-119 entry: every progress event refreshes the run's silence baseline. */
  readonly watchdog?: Pick<RunWatchdogService, 'noteActivity'>
  /**
   * TASK-130 hook: blocker / question events are reported here AFTER they are
   * persisted and broadcast. This Task only emits events — opening a Decision
   * is TASK-130's job.
   */
  readonly onBlocker?: (runId: string, event: AgentProgressEvent) => void
  readonly now?: () => string
  readonly pollIntervalMs?: number
}

export interface ProgressFollower {
  /**
   * Begins following the run's progress file; idempotent per run. Wired to
   * `agent.started` at creation — a resume re-follows from the offset where
   * the previous attempt's follower stopped, so already-persisted lines are
   * not replayed within this app session.
   */
  follow(runId: string): void
  /** One last drain after the run's terminal state, then stop. Idempotent. */
  finish(runId: string): void
  /** `teskra:agent:list-progress` — persisted events paged by seq. */
  list(request: ListAgentProgressRequest): IpcResult<AgentProgressRecord[]>
  /** Stops the timer and detaches from the EventBus; idempotent. */
  dispose(): void
}

interface FollowState {
  readonly path: string
  /** File offset of the next unread byte (bytes of `pending` included). */
  offset: number
  /** Bytes of an incomplete tail line kept for the next round. */
  pending: Buffer
  badLines: number
  /** Bad lines / read errors each WARN once per run, then stay silent. */
  badLineWarned: boolean
  readErrorWarned: boolean
}

/**
 * TASK-126 (Milestone 25 §8.2 / ADR-0012): reads the append-only progress
 * file the Agent writes at TESKRA_PROGRESS_PATH. Teskra is read-only here —
 * progress never changes Run state, never blocks completion, and a missing
 * file is the normal "Agent wrote nothing" case, not an error.
 */
export function createProgressFollower(deps: ProgressFollowerDeps): ProgressFollower {
  const logger = getLogger('agent')
  const now = deps.now ?? (() => new Date().toISOString())
  const pollIntervalMs = deps.pollIntervalMs ?? PROGRESS_POLL_INTERVAL_MS
  const states = new Map<string, FollowState>()
  /** runId → offset where the previous attempt's follower stopped (resume continuity). */
  const stoppedOffsets = new Map<string, number>()
  let timer: NodeJS.Timeout | undefined
  let disposed = false

  const readRange = (path: string, offset: number, length: number): Buffer => {
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

  const noteBadLine = (runId: string, state: FollowState, reason: string): void => {
    state.badLines += 1
    if (state.badLineWarned) return
    state.badLineWarned = true
    logger.warn(
      { runId, reason },
      'Progress file contains lines that fail validation; they are skipped and counted (this is the only warning for this run).',
    )
  }

  const persistAndBroadcast = (runId: string, event: AgentProgressEvent): void => {
    const timestamp = now()
    // §8.1: an absent `at` defaults to the time Teskra read the line.
    const filled: AgentProgressEvent = { ...event, at: event.at ?? timestamp }
    const redacted = redactSecrets(filled) as AgentProgressEvent
    // Same seq mechanism as every agent.* event: events.jsonl first, then
    // agent_events with the file-aligned seq (TASK-039 ordering).
    const durable = deps.runLogs.appendEvent(runId, PROGRESS_EVENT_TYPE, redacted, timestamp)
    if (!durable.ok) {
      logger.error(
        { runId, error: durable.error },
        'Failed to persist a durable progress event; the line is dropped.',
      )
      return
    }
    const appended = deps.agentEvents.append(
      {
        runId,
        seq: durable.data.seq,
        eventType: PROGRESS_EVENT_TYPE,
        payload: durable.data.payload,
      },
      timestamp,
    )
    if (!appended.ok) {
      logger.error(
        { runId, error: appended.error },
        'Failed to persist a progress event; the line is dropped.',
      )
      return
    }
    deps.events.emit('agent.progress', { runId, seq: durable.data.seq, event: redacted })
    deps.watchdog?.noteActivity(runId)
    if (redacted.kind === 'blocker' || redacted.kind === 'question') {
      deps.onBlocker?.(runId, redacted)
    }
  }

  const handleLine = (runId: string, state: FollowState, line: Buffer): void => {
    if (line.length > PROGRESS_MAX_LINE_BYTES) {
      noteBadLine(runId, state, `line exceeds ${String(PROGRESS_MAX_LINE_BYTES)} bytes`)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line.toString('utf8'))
    } catch {
      noteBadLine(runId, state, 'line is not valid JSON')
      return
    }
    const validated = agentProgressEventSchema.safeParse(parsed)
    if (!validated.success) {
      noteBadLine(runId, state, 'line failed the progress event schema')
      return
    }
    persistAndBroadcast(runId, validated.data)
  }

  const stopTruncated = (runId: string, state: FollowState, sizeBytes: number): void => {
    states.delete(runId)
    stoppedOffsets.set(runId, state.offset)
    const timestamp = now()
    const payload = { truncated: true, sizeBytes }
    const durable = deps.runLogs.appendEvent(runId, 'agent.progress_summary', payload, timestamp)
    if (!durable.ok) {
      logger.error(
        { runId, error: durable.error },
        'Failed to persist the progress truncation summary.',
      )
    } else {
      const appended = deps.agentEvents.append(
        {
          runId,
          seq: durable.data.seq,
          eventType: 'agent.progress_summary',
          payload: durable.data.payload,
        },
        timestamp,
      )
      if (!appended.ok) {
        logger.error(
          { runId, error: appended.error },
          'Failed to persist the progress truncation summary.',
        )
      }
    }
    deps.events.emit('agent.progress_summary', { runId, truncated: true, sizeBytes })
    logger.warn(
      { runId, sizeBytes },
      'Progress file exceeds 4 MiB; the follower stopped for this run.',
    )
  }

  /** Reads and processes every complete line appended since the last drain. */
  const drain = (runId: string, state: FollowState, final: boolean): void => {
    let size: number
    try {
      size = statSync(state.path).size
    } catch (cause) {
      // A missing file is the normal case (the Agent never wrote progress).
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' && !state.readErrorWarned) {
        state.readErrorWarned = true
        logger.warn({ runId, path: state.path, cause }, 'Progress file could not be read.')
      }
      return
    }
    if (size > PROGRESS_MAX_FILE_BYTES) {
      stopTruncated(runId, state, size)
      return
    }
    if (size < state.offset) {
      // The file was rewritten externally; re-read from the start.
      state.offset = 0
      state.pending = Buffer.alloc(0)
    }
    if (size > state.offset) {
      const fresh = readRange(state.path, state.offset, size - state.offset)
      state.offset = size
      const buffer = Buffer.concat([state.pending, fresh])
      const lastNewline = buffer.lastIndexOf(0x0a)
      const complete = lastNewline === -1 ? 0 : lastNewline + 1
      state.pending = buffer.subarray(complete)
      let position = 0
      for (let index = 0; index < complete; index += 1) {
        if (buffer[index] !== 0x0a) continue
        // Tolerate CRLF writers: trim a trailing \r before parsing.
        const end = index > position && buffer[index - 1] === 0x0d ? index - 1 : index
        handleLine(runId, state, buffer.subarray(position, end))
        position = index + 1
      }
    }
    if (final && state.pending.length > 0) {
      // The process is gone — the unterminated tail line will never complete;
      // parse it best-effort instead of dropping it.
      const tail = state.pending
      state.pending = Buffer.alloc(0)
      handleLine(runId, state, tail)
    }
    // An unterminated line already past the per-line ceiling can never become
    // valid — drop it now so `pending` cannot grow without bound.
    if (state.pending.length > PROGRESS_MAX_LINE_BYTES) {
      state.pending = Buffer.alloc(0)
      noteBadLine(runId, state, `line exceeds ${String(PROGRESS_MAX_LINE_BYTES)} bytes`)
    }
  }

  const tick = (): void => {
    for (const [runId, state] of [...states]) {
      try {
        drain(runId, state, false)
      } catch (cause) {
        logger.error({ runId, cause }, 'Progress follower drain failed unexpectedly.')
      }
    }
  }

  const ensureTimer = (): void => {
    if (timer === undefined && !disposed) {
      timer = setInterval(tick, pollIntervalMs)
    }
  }

  const follow = (runId: string): void => {
    if (disposed || states.has(runId)) return
    const files = deps.paths.runFiles(runId)
    if (!files.ok) {
      logger.error(
        { runId, error: files.error },
        'Progress follower could not resolve the run files.',
      )
      return
    }
    states.set(runId, {
      path: files.data.progress,
      offset: stoppedOffsets.get(runId) ?? 0,
      pending: Buffer.alloc(0),
      badLines: 0,
      badLineWarned: false,
      readErrorWarned: false,
    })
    ensureTimer()
  }

  const finish = (runId: string): void => {
    const state = states.get(runId)
    if (state === undefined) return
    states.delete(runId)
    try {
      drain(runId, state, true)
    } catch (cause) {
      logger.error({ runId, cause }, 'Progress follower final drain failed unexpectedly.')
    }
    stoppedOffsets.set(runId, state.offset)
    if (states.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  const stopStarted = deps.events.subscribe('agent.started', ({ runId }) => follow(runId))
  const stopTerminal = (
    ['agent.completed', 'agent.failed', 'agent.cancelled', 'agent.interrupted'] as const
  ).map((name) => deps.events.subscribe(name, ({ runId }) => finish(runId)))

  return {
    follow,
    finish,
    list(request) {
      const listed = deps.agentEvents.listByRunAndType(request.runId, PROGRESS_EVENT_TYPE, {
        ...(request.afterSeq === undefined ? {} : { afterSeq: request.afterSeq }),
        limit: request.limit ?? LIST_AGENT_PROGRESS_DEFAULT_LIMIT,
      })
      if (!listed.ok) return listed
      const records: AgentProgressRecord[] = []
      for (const row of listed.data) {
        // Written through persistAndBroadcast, so payloads re-validate; a row
        // that no longer parses is skipped rather than failing the page.
        const event = agentProgressEventSchema.safeParse(row.payload)
        if (!event.success) continue
        records.push({ seq: row.seq, event: event.data, createdAt: row.createdAt })
      }
      return { ok: true, data: records }
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
      stopStarted()
      for (const stop of stopTerminal) stop()
      states.clear()
      stoppedOffsets.clear()
    },
  }
}
