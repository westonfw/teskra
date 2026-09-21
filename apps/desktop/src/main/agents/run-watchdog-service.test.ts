import Database from 'better-sqlite3'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentFailureClassification,
  AgentRun,
  IpcResult,
  WatchdogConfig,
  WorkbenchEvents,
} from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import { createEventBus } from '../events/event-bus'
import type { UpdateAgentRunInput } from '../db/repositories/agent-run-repository'
import { createDecisionRepository } from '../decisions/decision-repository'
import { createDecisionService, type DecisionService } from '../decisions/decision-service'
import {
  createRunWatchdogService,
  WATCHDOG_MAX_PREPARING_CONFLICTS,
  WATCHDOG_TICK_MS,
  type RunWatchdogService,
} from './run-watchdog-service'

const BASE = Date.parse('2026-10-01T00:00:00.000Z')

const PREPARING_TIMEOUT_MS = 300_000
const IDLE_TIMEOUT_MS = 7_200_000

function iso(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString()
}

function makeRun(overrides: Partial<AgentRun>): AgentRun {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    agentType: 'fake',
    executionMode: 'attended',
    runDir: '/runs/run-1',
    status: 'running',
    createdAt: iso(-3_600_000),
    updatedAt: iso(-3_600_000),
    ...overrides,
  }
}

const CONFLICT_RESULT: IpcResult<AgentRun> = {
  ok: false,
  error: {
    code: 'CONFLICT',
    message: 'The Agent run is still launching; retry the continuation once it is running.',
    retryable: true,
  },
}

/** In-memory decision databases opened by harnesses, closed in afterEach. */
const connections: Database.Database[] = []

interface HarnessExtras {
  /** TASK-130: wire a real DecisionService (in-memory SQLite) into the watchdog. */
  readonly withDecisions?: boolean
  /** decisions.stalledRunTimeoutMs; default 0 (never expires). */
  readonly decisionTimeoutMs?: number
}

interface Harness {
  readonly service: RunWatchdogService
  readonly runs: AgentRun[]
  readonly failAndStop: ReturnType<
    typeof vi.fn<
      (runId: string, classification: AgentFailureClassification) => Promise<IpcResult<AgentRun>>
    >
  >
  readonly update: ReturnType<
    typeof vi.fn<
      (id: string, patch: UpdateAgentRunInput, now?: string) => IpcResult<AgentRun | null>
    >
  >
  readonly listActive: ReturnType<typeof vi.fn<() => IpcResult<AgentRun[]>>>
  readonly watchdogEvents: WorkbenchEvents['agent.watchdog'][]
  readonly stalledEvents: WorkbenchEvents['agent.stalled'][]
  readonly emitOutput: (runId: string) => void
  /** Present iff the harness was created with withDecisions. */
  readonly decisions?: DecisionService
}

function createHarness(
  config: Partial<WatchdogConfig>,
  initialRuns: AgentRun[],
  failAndStopImpl?: (runId: string) => Promise<IpcResult<AgentRun>>,
  extras?: HarnessExtras,
): Harness {
  const runs = [...initialRuns]
  const events = createEventBus()
  const watchdogEvents: WorkbenchEvents['agent.watchdog'][] = []
  const stalledEvents: WorkbenchEvents['agent.stalled'][] = []
  events.subscribe('agent.watchdog', (payload) => watchdogEvents.push(payload))
  events.subscribe('agent.stalled', (payload) => stalledEvents.push(payload))

  const failAndStop = vi.fn(
    async (
      runId: string,
      classification: AgentFailureClassification,
    ): Promise<IpcResult<AgentRun>> => {
      void classification
      if (failAndStopImpl !== undefined) return failAndStopImpl(runId)
      // Mimic the real AgentManager: the run settles to failed and leaves the
      // active set.
      const index = runs.findIndex((run) => run.id === runId)
      const run = runs[index]
      if (run === undefined)
        return { ok: false, error: { code: 'UNKNOWN', message: 'gone', retryable: false } }
      runs.splice(index, 1)
      return { ok: true, data: { ...run, status: 'failed' } }
    },
  )
  const update = vi.fn(
    (id: string, patch: UpdateAgentRunInput, now?: string): IpcResult<AgentRun | null> => {
      const run = runs.find((candidate) => candidate.id === id)
      if (run === undefined) return { ok: true, data: null }
      Object.assign(run, patch)
      if (now !== undefined) run.updatedAt = now
      return { ok: true, data: run }
    },
  )
  const listActive = vi.fn((): IpcResult<AgentRun[]> => ({
    ok: true,
    // Mirror the repository's partial index: terminal rows are never listed.
    data: runs.filter(
      (run) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status),
    ),
  }))

  const watchdogConfig: WatchdogConfig = {
    stalledThresholdMs: 600_000,
    preparingTimeoutMs: PREPARING_TIMEOUT_MS,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    idleAction: 'ask',
    ...config,
  }
  // TASK-130: a real DecisionService over in-memory SQLite. The FK references
  // (workspace, agent_runs) mirror the harness's in-memory run set.
  let decisions: DecisionService | undefined
  if (extras?.withDecisions === true) {
    const connection = new Database(':memory:')
    connection.pragma('foreign_keys = ON')
    const migrated = migrateDatabase(connection)
    if (!migrated.ok) throw new Error(migrated.error.message)
    connections.push(connection)
    connection
      .prepare(
        `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
         VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', '${iso(0)}', '${iso(0)}')`,
      )
      .run()
    for (const run of initialRuns) {
      connection
        .prepare(
          `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
           VALUES (?, 'ws-1', 'fake', ?, 'attended', 'runs/' || ?, '${iso(0)}', '${iso(0)}')`,
        )
        .run(run.id, run.status, run.id)
    }
    decisions = createDecisionService({ decisions: createDecisionRepository(connection), events })
  }
  const service = createRunWatchdogService({
    runs: { listActive, update },
    agents: { failAndStop },
    events,
    resolveConfig: () => ({ ok: true, data: watchdogConfig }),
    ...(decisions === undefined
      ? {}
      : {
          decisions,
          resolveDecisionTimeoutMs: () => extras?.decisionTimeoutMs ?? 0,
        }),
  })
  return {
    service,
    runs,
    failAndStop,
    update,
    listActive,
    watchdogEvents,
    stalledEvents,
    emitOutput: (runId) => events.emit('agent.output', { runId, data: 'chunk' }),
    ...(decisions === undefined ? {} : { decisions }),
  }
}

describe('RunWatchdogService (TASK-119)', () => {
  let harness: Harness | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE)
  })

  afterEach(() => {
    harness?.service.dispose()
    harness = undefined
    for (const connection of connections.splice(0)) connection.close()
    vi.useRealTimers()
  })

  it('fails a preparing run whose updatedAt is older than preparingTimeoutMs', async () => {
    harness = createHarness({}, [
      makeRun({ id: 'run-preparing', status: 'preparing', updatedAt: iso(-PREPARING_TIMEOUT_MS) }),
    ])

    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)

    // Tick fires at BASE + 15s: silent for 300s + 15s.
    expect(harness.failAndStop).toHaveBeenCalledOnce()
    expect(harness.failAndStop).toHaveBeenCalledWith('run-preparing', {
      kind: 'process-crash',
      retryable: true,
      evidence: 'preparing timed out after 315s',
    })
    expect(harness.watchdogEvents).toEqual([
      { runId: 'run-preparing', check: 'preparing_timeout', silentForMs: 315_000 },
    ])
    // The double settled the run to failed; the next tick does not retry it.
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)
    expect(harness.failAndStop).toHaveBeenCalledOnce()
  })

  it('leaves a preparing run inside the timeout untouched', async () => {
    harness = createHarness({}, [
      makeRun({ id: 'run-preparing', status: 'preparing', updatedAt: iso(-60_000) }),
    ])

    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS * 2)

    expect(harness.failAndStop).not.toHaveBeenCalled()
    expect(harness.watchdogEvents).toEqual([])
  })

  it.each(['created', 'queued'] as const)(
    'does not count %s runs toward the preparing timeout',
    async (status) => {
      harness = createHarness({ idleTimeoutMs: 0 }, [
        makeRun({ id: `run-${status}`, status, updatedAt: iso(-10 * PREPARING_TIMEOUT_MS) }),
      ])

      await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS * 2)

      expect(harness.failAndStop).not.toHaveBeenCalled()
      expect(harness.watchdogEvents).toEqual([])
      expect(harness.stalledEvents).toEqual([])
    },
  )

  it('escalates to agent.stalled after 3 consecutive CONFLICTs and stops forcing', async () => {
    harness = createHarness(
      {},
      [
        makeRun({
          id: 'run-hung-launch',
          status: 'preparing',
          updatedAt: iso(-PREPARING_TIMEOUT_MS),
        }),
      ],
      async () => CONFLICT_RESULT,
    )

    // The first two CONFLICTs are logged and retried — no escalation yet, and
    // the run is never written failed while its launch is in flight.
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)
    expect(harness.failAndStop).toHaveBeenCalledTimes(2)
    expect(harness.stalledEvents).toEqual([])
    expect(harness.runs.find((run) => run.id === 'run-hung-launch')?.status).toBe('preparing')

    // The third consecutive CONFLICT escalates to agent.stalled.
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)
    expect(harness.failAndStop).toHaveBeenCalledTimes(WATCHDOG_MAX_PREPARING_CONFLICTS)
    expect(harness.stalledEvents).toEqual([
      { runId: 'run-hung-launch', silentForMs: 345_000, action: 'ask' },
    ])

    // Escalated: further ticks neither force-stop nor re-notify.
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS * 3)
    expect(harness.failAndStop).toHaveBeenCalledTimes(WATCHDOG_MAX_PREPARING_CONFLICTS)
    expect(harness.stalledEvents).toHaveLength(1)
  })

  it('stops an idle running run when idleAction is stop', async () => {
    harness = createHarness({ idleAction: 'stop' }, [
      makeRun({
        id: 'run-idle',
        status: 'running',
        startedAt: iso(-IDLE_TIMEOUT_MS - 60_000),
        lastOutputAt: iso(-IDLE_TIMEOUT_MS),
      }),
    ])

    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)

    // Silent for 120min + 15s → floored to 120 min.
    expect(harness.failAndStop).toHaveBeenCalledWith('run-idle', {
      kind: 'unknown',
      retryable: true,
      evidence: 'idle for 120 min',
    })
    expect(harness.watchdogEvents).toEqual([
      { runId: 'run-idle', check: 'idle', silentForMs: IDLE_TIMEOUT_MS + 15_000 },
    ])
    expect(harness.stalledEvents).toEqual([
      { runId: 'run-idle', silentForMs: IDLE_TIMEOUT_MS + 15_000, action: 'stop' },
    ])
  })

  it('only emits agent.stalled when idleAction is ask, leaving the run untouched', async () => {
    harness = createHarness({ idleAction: 'ask' }, [
      makeRun({
        id: 'run-idle',
        status: 'running',
        startedAt: iso(-IDLE_TIMEOUT_MS - 60_000),
        lastOutputAt: iso(-IDLE_TIMEOUT_MS),
      }),
    ])

    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS * 3)

    expect(harness.failAndStop).not.toHaveBeenCalled()
    expect(harness.runs.find((run) => run.id === 'run-idle')?.status).toBe('running')
    // One notification per stall episode — the follow-up ticks stay silent.
    expect(harness.stalledEvents).toEqual([
      { runId: 'run-idle', silentForMs: IDLE_TIMEOUT_MS + 15_000, action: 'ask' },
    ])
  })

  it.each([
    'waiting_for_user',
    'waiting_for_permission',
    'waiting_for_agent',
    'reviewing',
  ] as const)('judges %s runs with the idle watchdog', async (status) => {
    harness = createHarness({ idleAction: 'ask' }, [
      makeRun({
        id: `run-${status}`,
        status,
        startedAt: iso(-IDLE_TIMEOUT_MS - 60_000),
        lastOutputAt: iso(-IDLE_TIMEOUT_MS),
      }),
    ])

    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)

    expect(harness.stalledEvents).toHaveLength(1)
    expect(harness.stalledEvents[0]?.runId).toBe(`run-${status}`)
  })

  it('disables the idle watchdog when idleTimeoutMs is 0', async () => {
    harness = createHarness({ idleTimeoutMs: 0 }, [
      makeRun({
        id: 'run-idle',
        status: 'running',
        startedAt: iso(-IDLE_TIMEOUT_MS * 10),
        lastOutputAt: iso(-IDLE_TIMEOUT_MS * 10),
      }),
    ])

    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS * 3)

    expect(harness.failAndStop).not.toHaveBeenCalled()
    expect(harness.stalledEvents).toEqual([])
    expect(harness.watchdogEvents).toEqual([])
  })

  it('treats PTY output (agent.output) as activity that resets the silence baseline', async () => {
    harness = createHarness({ idleAction: 'ask' }, [
      makeRun({
        id: 'run-active',
        status: 'running',
        startedAt: iso(-IDLE_TIMEOUT_MS - 60_000),
        lastOutputAt: iso(-IDLE_TIMEOUT_MS),
      }),
    ])

    // Output arrives at BASE — before the first tick the run is silent again
    // only from this point on.
    harness.emitOutput('run-active')
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS * 2)
    expect(harness.stalledEvents).toEqual([])

    // Once the noted activity ages past the idle threshold, the stall fires.
    vi.setSystemTime(BASE + IDLE_TIMEOUT_MS + 30_000)
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)
    expect(harness.stalledEvents).toHaveLength(1)
  })

  it('acknowledgeIdle persists last_input_at and pushes the idle baseline to now', async () => {
    harness = createHarness({ idleAction: 'ask' }, [
      makeRun({
        id: 'run-idle',
        status: 'running',
        startedAt: iso(-IDLE_TIMEOUT_MS - 60_000),
        lastOutputAt: iso(-IDLE_TIMEOUT_MS),
      }),
    ])

    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)
    expect(harness.stalledEvents).toHaveLength(1)

    // User chooses "keep waiting" at BASE + 15s (the current fake time).
    const acknowledged = harness.service.acknowledgeIdle('run-idle')
    expect(acknowledged.ok).toBe(true)
    expect(harness.update).toHaveBeenCalledWith(
      'run-idle',
      { lastInputAt: new Date(BASE + WATCHDOG_TICK_MS).toISOString() },
      new Date(BASE + WATCHDOG_TICK_MS).toISOString(),
    )

    // The stall episode restarts from the acknowledgement: no new event.
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS * 4)
    expect(harness.stalledEvents).toHaveLength(1)

    // Once the acknowledgement itself ages past the idle timeout, it fires again.
    vi.setSystemTime(BASE + WATCHDOG_TICK_MS + IDLE_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)
    expect(harness.stalledEvents).toHaveLength(2)
    expect(harness.stalledEvents[1]?.silentForMs).toBe(IDLE_TIMEOUT_MS + WATCHDOG_TICK_MS)
  })

  it('acknowledgeIdle fails cleanly for an unknown run', () => {
    harness = createHarness({}, [])

    const result = harness.service.acknowledgeIdle('missing-run')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('skips a tick while the previous one is still in flight (no queueing)', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    harness = createHarness(
      {},
      [
        makeRun({
          id: 'run-slow-stop',
          status: 'preparing',
          updatedAt: iso(-PREPARING_TIMEOUT_MS),
        }),
      ],
      async () => {
        await gate
        return CONFLICT_RESULT
      },
    )

    // The first tick starts and blocks inside failAndStop; the next three
    // interval fires must be skipped, not queued.
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS * 3)
    expect(harness.failAndStop).toHaveBeenCalledOnce()

    release?.()
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)
    // After the gate released, exactly one more tick ran the check again.
    expect(harness.failAndStop).toHaveBeenCalledTimes(2)
  })

  it('stops ticking after dispose()', async () => {
    harness = createHarness({}, [
      makeRun({ id: 'run-preparing', status: 'preparing', updatedAt: iso(-PREPARING_TIMEOUT_MS) }),
    ])

    harness.service.dispose()
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS * 5)

    expect(harness.listActive).not.toHaveBeenCalled()
    expect(harness.failAndStop).not.toHaveBeenCalled()
  })

  it('TASK-128: onTick listeners run at the end of every tick with the tick time', async () => {
    harness = createHarness({}, [])
    const ticks: string[] = []
    const off = harness.service.onTick((now) => ticks.push(now))
    harness.service.onTick(() => {
      throw new Error('boom')
    })

    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS * 2)

    // A throwing listener neither breaks the tick nor the other listeners.
    expect(ticks).toEqual([iso(WATCHDOG_TICK_MS), iso(WATCHDOG_TICK_MS * 2)])

    // Unsubscribe is honored; dispose stops the timer and drops the rest.
    off()
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)
    expect(ticks).toHaveLength(2)
  })

  it('TASK-130: idleAction ask opens exactly one stalled_run decision per run', async () => {
    harness = createHarness(
      { idleAction: 'ask' },
      [
        makeRun({
          id: 'run-idle',
          status: 'running',
          startedAt: iso(-IDLE_TIMEOUT_MS - 60_000),
          lastOutputAt: iso(-IDLE_TIMEOUT_MS),
        }),
      ],
      undefined,
      { withDecisions: true },
    )

    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)

    const decisions = harness.decisions as DecisionService
    const open = decisions.list({ kind: 'stalled_run', status: 'open' })
    expect(open.ok && open.data.length === 1).toBe(true)
    if (!open.ok || open.data[0] === undefined) return
    expect(open.data[0]).toMatchObject({
      workspaceId: 'ws-1',
      kind: 'stalled_run',
      severity: 'warning',
      runId: 'run-idle',
      dedupeKey: 'run-idle',
      detail: { kind: 'stalled_run', silentForMs: IDLE_TIMEOUT_MS + 15_000 },
      options: [
        { id: 'keep_waiting', label: 'Keep waiting' },
        { id: 'stop', label: 'Stop the run' },
      ],
    })
    // decisions.stalledRunTimeoutMs defaults to 0: the decision never expires.
    expect(open.data[0].expiresAt).toBeUndefined()

    // The same stall episode never opens a second row.
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS * 3)
    const stillOpen = decisions.list({ kind: 'stalled_run', status: 'open' })
    expect(stillOpen.ok && stillOpen.data.length === 1).toBe(true)
  })

  it('TASK-130: keep_waiting acknowledges the idle baseline and ends the stall episode', async () => {
    harness = createHarness(
      { idleAction: 'ask' },
      [
        makeRun({
          id: 'run-idle',
          status: 'running',
          startedAt: iso(-IDLE_TIMEOUT_MS - 60_000),
          lastOutputAt: iso(-IDLE_TIMEOUT_MS),
        }),
      ],
      undefined,
      { withDecisions: true },
    )
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)
    const decisions = harness.decisions as DecisionService
    const open = decisions.list({ kind: 'stalled_run', status: 'open' })
    const decision = open.ok ? open.data[0] : undefined
    expect(decision).toBeDefined()
    if (decision === undefined) return

    const resolved = decisions.resolve(decision.id, 'keep_waiting', 'user')
    expect(resolved.ok).toBe(true)

    // acknowledgeIdle ran: last_input_at persisted at the current (fake) time.
    expect(harness.update).toHaveBeenCalledWith(
      'run-idle',
      { lastInputAt: iso(WATCHDOG_TICK_MS) },
      iso(WATCHDOG_TICK_MS),
    )
    expect(harness.failAndStop).not.toHaveBeenCalled()

    // The baseline moved: the follow-up ticks stay silent.
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS * 3)
    expect(harness.stalledEvents).toHaveLength(1)
  })

  it('TASK-130: stop resolves to failAndStop with an unknown, retryable classification', async () => {
    harness = createHarness(
      { idleAction: 'ask' },
      [
        makeRun({
          id: 'run-idle',
          status: 'running',
          startedAt: iso(-IDLE_TIMEOUT_MS - 60_000),
          lastOutputAt: iso(-IDLE_TIMEOUT_MS),
        }),
      ],
      undefined,
      { withDecisions: true },
    )
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)
    const decisions = harness.decisions as DecisionService
    const open = decisions.list({ kind: 'stalled_run', status: 'open' })
    const decision = open.ok ? open.data[0] : undefined
    if (decision === undefined) throw new Error('expected an open stalled_run decision')

    const resolved = decisions.resolve(decision.id, 'stop', 'user')
    expect(resolved.ok).toBe(true)
    // The handler's failAndStop promise settles on the microtask queue.
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.failAndStop).toHaveBeenCalledWith('run-idle', {
      kind: 'unknown',
      retryable: true,
      evidence: 'stopped from the stalled-run decision after 120 min idle',
    })
  })

  it('TASK-130: an expired stalled_run decision applies keep_waiting (the §9.1 default)', async () => {
    harness = createHarness(
      { idleAction: 'ask' },
      [
        makeRun({
          id: 'run-idle',
          status: 'running',
          startedAt: iso(-IDLE_TIMEOUT_MS - 60_000),
          lastOutputAt: iso(-IDLE_TIMEOUT_MS),
        }),
      ],
      undefined,
      { withDecisions: true, decisionTimeoutMs: 60_000 },
    )
    await vi.advanceTimersByTimeAsync(WATCHDOG_TICK_MS)
    const decisions = harness.decisions as DecisionService
    const open = decisions.list({ kind: 'stalled_run', status: 'open' })
    const decision = open.ok ? open.data[0] : undefined
    if (decision === undefined) throw new Error('expected an open stalled_run decision')
    // Opened at BASE + 15s with a 60s timeout.
    expect(decision.expiresAt).toBe(iso(WATCHDOG_TICK_MS + 60_000))

    const expired = decisions.expire(iso(WATCHDOG_TICK_MS + 60_000))
    expect(expired.ok && expired.data.length === 1).toBe(true)
    if (!expired.ok || expired.data[0] === undefined) return
    expect(expired.data[0].status).toBe('expired')
    expect(expired.data[0].resolution).toMatchObject({
      optionId: 'keep_waiting',
      decidedBy: 'timeout',
    })
    // The timeout default executes the same keep_waiting action: the run's
    // silence baseline was refreshed, the run was not stopped.
    expect(harness.update).toHaveBeenCalledWith(
      'run-idle',
      { lastInputAt: iso(WATCHDOG_TICK_MS) },
      iso(WATCHDOG_TICK_MS),
    )
    expect(harness.failAndStop).not.toHaveBeenCalled()
  })
})
