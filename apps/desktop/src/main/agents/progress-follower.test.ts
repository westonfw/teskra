import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentProgressEvent, WorkbenchEvents } from '@teskra/contracts'

import type { AgentEvent, AgentEventRepository } from '../db/repositories/agent-event-repository'
import { createEventBus, type EventBus } from '../events/event-bus'
import { initializeLogging, resetLoggingStateForTests } from '../logger'
import { createTeskraPaths, type TeskraPaths } from '../paths'
import {
  createProgressFollower,
  PROGRESS_MAX_FILE_BYTES,
  type ProgressFollower,
} from './progress-follower'
import { createRunLogStore, type RunLogStore } from './run-log-store'

const homes: string[] = []

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetLoggingStateForTests()
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

interface Fixture {
  readonly home: string
  readonly paths: TeskraPaths
  readonly runLogs: RunLogStore
  readonly agentEvents: Pick<AgentEventRepository, 'append' | 'listByRunAndType'>
  readonly appended: AgentEvent[]
  readonly events: EventBus<WorkbenchEvents>
  readonly broadcasts: WorkbenchEvents['agent.progress'][]
  readonly summaries: WorkbenchEvents['agent.progress_summary'][]
  readonly watchdog: { noteActivity: ReturnType<typeof vi.fn> }
  readonly blockers: [string, AgentProgressEvent][]
  readonly follower: ProgressFollower
  readonly progressPath: string
}

function setup(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'teskra-progress-'))
  homes.push(home)
  const paths = createTeskraPaths({ TESKRA_HOME: home })
  const runLogs = createRunLogStore({ paths })
  const runDir = join(home, 'runs', 'run-1')
  const initialized = runLogs.initialize({
    id: 'run-1',
    workspaceId: 'workspace-1',
    agentType: 'codex',
    status: 'running',
    executionMode: 'attended',
    runDir,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  })
  if (!initialized.ok) throw new Error('run log initialization failed')

  const appended: AgentEvent[] = []
  const agentEvents: Fixture['agentEvents'] = {
    append: vi.fn((input) => {
      const record: AgentEvent = {
        id: appended.length + 1,
        runId: input.runId,
        seq: input.seq,
        eventType: input.eventType,
        payload: input.payload,
        createdAt: '2026-09-10T00:00:01.000Z',
      }
      appended.push(record)
      return { ok: true as const, data: record }
    }),
    listByRunAndType: vi.fn(() => ({ ok: true as const, data: [] })),
  }
  const events = createEventBus()
  const broadcasts: Fixture['broadcasts'] = []
  const summaries: Fixture['summaries'] = []
  events.subscribe('agent.progress', (payload) => broadcasts.push(payload))
  events.subscribe('agent.progress_summary', (payload) => summaries.push(payload))
  const watchdog = { noteActivity: vi.fn() }
  const blockers: Fixture['blockers'] = []
  const follower = createProgressFollower({
    paths,
    runLogs,
    agentEvents,
    events,
    watchdog,
    onBlocker: (runId, event) => blockers.push([runId, event]),
    now: () => '2026-09-10T00:00:01.000Z',
  })
  return {
    home,
    paths,
    runLogs,
    agentEvents,
    appended,
    events,
    broadcasts,
    summaries,
    watchdog,
    blockers,
    follower,
    progressPath: join(runDir, 'progress.jsonl'),
  }
}

function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`
}

/** Starts the follower the way production does and runs one poll round. */
function startAndTick(fixture: Fixture, ticks = 1): void {
  fixture.events.emit('agent.started', { runId: 'run-1' })
  vi.advanceTimersByTime(1_000 * ticks)
}

/**
 * Arms the file-backed agent log BEFORE the follower captures its logger, and
 * returns a reader for the WARN records (the repo's log-assertion pattern).
 */
function setupWithAgentLog(): { fixture: Fixture; warnings: () => Array<Record<string, unknown>> } {
  resetLoggingStateForTests()
  const logHome = mkdtempSync(join(tmpdir(), 'teskra-progress-log-'))
  homes.push(logHome)
  const initialized = initializeLogging(createTeskraPaths({ TESKRA_HOME: logHome }), {
    sync: true,
  })
  if (!initialized.ok) throw new Error(initialized.error.message)
  const fixture = setup()
  const warnings = (): Array<Record<string, unknown>> =>
    readFileSync(join(logHome, 'logs', 'agent.log'), 'utf8')
      .trim()
      .split('\n')
      .filter((entry) => entry.length > 0)
      .map((entry) => JSON.parse(entry) as Record<string, unknown>)
      .filter((record) => record['level'] === 40)
  return { fixture, warnings }
}

beforeEach(() => {
  vi.useFakeTimers()
})

describe('ProgressFollower (TASK-126 / ADR-0012)', () => {
  it('reads only newly appended bytes across polls (offset tracking)', () => {
    const fixture = setup()
    writeFileSync(fixture.progressPath, line({ kind: 'progress', message: 'first', percent: 10 }))

    startAndTick(fixture)
    expect(fixture.broadcasts.map(({ event }) => event.message)).toEqual(['first'])

    appendFileSync(fixture.progressPath, line({ kind: 'note', message: 'second' }))
    vi.advanceTimersByTime(1_000)
    expect(fixture.broadcasts.map(({ event }) => event.message)).toEqual(['first', 'second'])
    // events.jsonl + agent_events share the file-aligned seq.
    expect(fixture.broadcasts.map(({ seq }) => seq)).toEqual([1, 2])
    expect(fixture.appended.map(({ eventType, seq }) => [eventType, seq])).toEqual([
      ['agent.progress', 1],
      ['agent.progress', 2],
    ])
    fixture.follower.dispose()
  })

  it('keeps an incomplete tail line for the next poll round', () => {
    const fixture = setup()
    const full = line({ kind: 'progress', message: 'split across polls' })
    writeFileSync(fixture.progressPath, full.slice(0, 12))

    startAndTick(fixture)
    expect(fixture.broadcasts).toEqual([])

    appendFileSync(fixture.progressPath, full.slice(12))
    vi.advanceTimersByTime(1_000)
    expect(fixture.broadcasts.map(({ event }) => event.message)).toEqual(['split across polls'])
    fixture.follower.dispose()
  })

  it('skips and counts bad lines, warning only once per run', () => {
    const { fixture, warnings } = setupWithAgentLog()
    writeFileSync(
      fixture.progressPath,
      `not json\n${line({ kind: 'bogus', message: 'bad kind' })}${line({ kind: 'progress', message: 'good' })}`,
    )

    startAndTick(fixture)
    expect(fixture.broadcasts.map(({ event }) => event.message)).toEqual(['good'])
    expect(warnings()).toHaveLength(1)

    appendFileSync(fixture.progressPath, 'still not json\n')
    vi.advanceTimersByTime(1_000)
    expect(warnings()).toHaveLength(1)
    fixture.follower.dispose()
  })

  it('skips a single line over 8 KiB but keeps following', () => {
    const fixture = setup()
    writeFileSync(
      fixture.progressPath,
      line({ kind: 'progress', message: 'x'.repeat(9 * 1024) }) +
        line({ kind: 'progress', message: 'small' }),
    )

    startAndTick(fixture)
    expect(fixture.broadcasts.map(({ event }) => event.message)).toEqual(['small'])

    appendFileSync(fixture.progressPath, line({ kind: 'note', message: 'after' }))
    vi.advanceTimersByTime(1_000)
    expect(fixture.broadcasts.map(({ event }) => event.message)).toEqual(['small', 'after'])
    fixture.follower.dispose()
  })

  it('stops following a file over 4 MiB and writes agent.progress_summary', () => {
    const fixture = setup()
    writeFileSync(fixture.progressPath, Buffer.alloc(PROGRESS_MAX_FILE_BYTES + 1, 0x78))

    startAndTick(fixture)
    expect(fixture.broadcasts).toEqual([])
    expect(fixture.summaries).toEqual([
      { runId: 'run-1', truncated: true, sizeBytes: PROGRESS_MAX_FILE_BYTES + 1 },
    ])
    expect(fixture.appended.map(({ eventType }) => eventType)).toEqual(['agent.progress_summary'])

    // No longer following: appends below the radar stay unread.
    appendFileSync(fixture.progressPath, line({ kind: 'progress', message: 'late' }))
    vi.advanceTimersByTime(5_000)
    expect(fixture.broadcasts).toEqual([])
    fixture.follower.dispose()
  })

  it('treats a missing progress file as normal — no error, no warning', () => {
    const { fixture, warnings } = setupWithAgentLog()

    startAndTick(fixture, 3)
    expect(fixture.broadcasts).toEqual([])
    expect(warnings()).toEqual([])
    fixture.follower.dispose()
  })

  it('refreshes the watchdog silence baseline for every progress event', () => {
    const fixture = setup()
    writeFileSync(
      fixture.progressPath,
      line({ kind: 'progress', message: 'one' }) + line({ kind: 'note', message: 'two' }),
    )

    startAndTick(fixture)
    expect(fixture.watchdog.noteActivity.mock.calls).toEqual([['run-1'], ['run-1']])
    fixture.follower.dispose()
  })

  it('drains once after the terminal event, flushes the unterminated tail, then stops', () => {
    const fixture = setup()
    writeFileSync(fixture.progressPath, line({ kind: 'progress', message: 'before exit' }))

    startAndTick(fixture)
    // Written after the last poll and never newline-terminated — the final
    // drain must still pick both up (the process is gone, no next round).
    appendFileSync(fixture.progressPath, line({ kind: 'note', message: 'last word' }))
    appendFileSync(fixture.progressPath, JSON.stringify({ kind: 'note', message: 'no newline' }))
    fixture.events.emit('agent.completed', { runId: 'run-1', exitCode: 0 })

    expect(fixture.broadcasts.map(({ event }) => event.message)).toEqual([
      'before exit',
      'last word',
      'no newline',
    ])

    appendFileSync(fixture.progressPath, line({ kind: 'progress', message: 'too late' }))
    vi.advanceTimersByTime(5_000)
    expect(fixture.broadcasts).toHaveLength(3)
    fixture.follower.dispose()
  })

  it('redacts secrets before persisting and broadcasting', () => {
    const fixture = setup()
    writeFileSync(
      fixture.progressPath,
      line({ kind: 'progress', message: 'uploaded with sk-livekey123456', data: { token: 'x' } }),
    )

    startAndTick(fixture)
    expect(fixture.broadcasts[0]?.event.message).toBe('uploaded with [redacted]')
    expect(fixture.broadcasts[0]?.event.data).toEqual({ token: '[redacted]' })
    const persisted = fixture.appended[0]?.payload as { message: string }
    expect(persisted.message).toBe('uploaded with [redacted]')
    fixture.follower.dispose()
  })

  it('fills `at` with the read time when the Agent omitted it', () => {
    const fixture = setup()
    writeFileSync(fixture.progressPath, line({ kind: 'progress', message: 'no timestamp' }))

    startAndTick(fixture)
    expect(fixture.broadcasts[0]?.event.at).toBe('2026-09-10T00:00:01.000Z')
    fixture.follower.dispose()
  })

  it('reports blocker/question events through the callback without changing run state', () => {
    const fixture = setup()
    writeFileSync(
      fixture.progressPath,
      line({ kind: 'blocker', message: 'need a human' }) +
        line({ kind: 'question', message: 'which option?' }),
    )

    startAndTick(fixture)
    expect(fixture.blockers.map(([runId, event]) => [runId, event.kind])).toEqual([
      ['run-1', 'blocker'],
      ['run-1', 'question'],
    ])
    // Both are ordinary agent.progress events too — Run state is untouched.
    expect(fixture.broadcasts.map(({ event }) => event.kind)).toEqual(['blocker', 'question'])
    fixture.follower.dispose()
  })

  it('resumes from the stopped offset when the run starts again in this session', () => {
    const fixture = setup()
    writeFileSync(fixture.progressPath, line({ kind: 'progress', message: 'attempt one' }))
    startAndTick(fixture)
    fixture.events.emit('agent.interrupted', { runId: 'run-1', reason: 'process_dead' })

    // The resumed attempt keeps the same progress file; already-persisted
    // lines must not be replayed.
    fixture.events.emit('agent.started', { runId: 'run-1' })
    vi.advanceTimersByTime(1_000)
    expect(fixture.broadcasts.map(({ event }) => event.message)).toEqual(['attempt one'])
    fixture.follower.dispose()
  })

  it('lists persisted progress events paged by seq', () => {
    const fixture = setup()
    const rows: AgentEvent[] = [
      {
        id: 1,
        runId: 'run-1',
        seq: 3,
        eventType: 'agent.progress',
        payload: { kind: 'progress', message: 'one' },
        createdAt: '2026-09-10T00:00:01.000Z',
      },
      {
        id: 2,
        runId: 'run-1',
        seq: 5,
        eventType: 'agent.progress',
        // A payload that no longer validates is skipped, not fatal.
        payload: { kind: 'bogus' },
        createdAt: '2026-09-10T00:00:02.000Z',
      },
    ]
    fixture.agentEvents.listByRunAndType = vi.fn(() => ({ ok: true as const, data: rows }))

    const listed = fixture.follower.list({ runId: 'run-1', afterSeq: 2, limit: 50 })
    expect(fixture.agentEvents.listByRunAndType).toHaveBeenCalledWith('run-1', 'agent.progress', {
      afterSeq: 2,
      limit: 50,
    })
    expect(listed).toEqual({
      ok: true,
      data: [
        {
          seq: 3,
          event: { kind: 'progress', message: 'one' },
          createdAt: '2026-09-10T00:00:01.000Z',
        },
      ],
    })

    fixture.follower.list({ runId: 'run-1' })
    expect(fixture.agentEvents.listByRunAndType).toHaveBeenCalledWith('run-1', 'agent.progress', {
      limit: 200,
    })
    fixture.follower.dispose()
  })
})
