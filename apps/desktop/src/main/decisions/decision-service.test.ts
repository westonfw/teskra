import Database from 'better-sqlite3'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PendingDecision, WorkbenchEvents } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createDecisionRepository } from './decision-repository'
import {
  createDecisionService,
  DECISION_TIMEOUT_DEFAULT_OPTIONS,
  type DecisionService,
  type OpenDecisionInput,
} from './decision-service'

/**
 * TASK-128 acceptance (teskra-tasks.md; ADR-0014; design doc §9.1 / §15):
 * in-memory SQLite through migrateDatabase (the real 019 DDL), the real
 * EventBus, and a real DecisionRepository — only the id generator is faked.
 */

const T0 = '2026-09-22T00:00:00.000Z'
const T1 = '2026-09-22T00:05:00.000Z'
const T2 = '2026-09-22T01:00:00.000Z'

let connection: Database.Database
let events: EventBus<WorkbenchEvents>
let service: DecisionService
let openedEvents: PendingDecision[]
let resolvedEvents: PendingDecision[]

function setup() {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
  connection
    .prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', '${T0}', '${T0}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
       VALUES ('run-1', 'ws-1', 'codex', 'running', 'orchestrated', 'runs/run-1', '${T0}', '${T0}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO workflow_runs (id, task_id, workflow_definition_id, definition_json, status, created_at)
       VALUES ('wfr-1', NULL, 'def', '{}', 'running', '${T0}')`,
    )
    .run()
  events = createEventBus()
  openedEvents = []
  resolvedEvents = []
  events.subscribe('decision.opened', ({ decision }) => openedEvents.push(decision))
  events.subscribe('decision.resolved', ({ decision }) => resolvedEvents.push(decision))
  let sequence = 0
  service = createDecisionService({
    decisions: createDecisionRepository(connection),
    events,
    createId: () => `dec-${++sequence}`,
  })
}

afterEach(() => {
  connection.close()
})

function openInput(overrides: Partial<OpenDecisionInput> = {}): OpenDecisionInput {
  return {
    workspaceId: 'ws-1',
    kind: 'shell_confirmation',
    severity: 'blocking',
    dedupeKey: 'shell_confirmation:step-1',
    title: 'Confirm shell step',
    detail: { kind: 'shell_confirmation', command: 'npm run build', cwd: '/repo' },
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
    ...overrides,
  }
}

describe('DecisionService.open (TASK-128)', () => {
  it('opens a decision, persists it and emits decision.opened once', () => {
    setup()
    const opened = service.open(openInput(), T0)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.data.status).toBe('open')
    expect(openedEvents.map((decision) => decision.id)).toEqual([opened.data.id])
  })

  it('is idempotent on dedupeKey: concurrent opens yield one row and one event', async () => {
    setup()
    // True concurrency: both opens are issued before either result is read.
    // better-sqlite3 is synchronous, so they serialize inside one connection;
    // the partial unique index is the guard if a second connection ever races.
    const [first, second] = await Promise.all([
      Promise.resolve(service.open(openInput(), T0)),
      Promise.resolve(service.open(openInput(), T0)),
    ])
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.data.id).toBe(first.data.id)

    const all = service.list({ status: 'open' })
    expect(all.ok && all.data.length === 1).toBe(true)
    expect(openedEvents).toHaveLength(1)
  })

  it('computes expiresAt from timeoutMs; 0 / absent means never expires', () => {
    setup()
    const timed = service.open(openInput({ timeoutMs: 300_000 }), T0)
    expect(timed.ok && timed.data.expiresAt === '2026-09-22T00:05:00.000Z').toBe(true)

    const untimed = service.open(openInput({ dedupeKey: 'k:2', timeoutMs: 0 }), T0)
    expect(untimed.ok && untimed.data.expiresAt === undefined).toBe(true)

    const defaulted = service.open(openInput({ dedupeKey: 'k:3' }), T0)
    expect(defaulted.ok && defaulted.data.expiresAt === undefined).toBe(true)
  })

  it('rejects a detail that does not match the kind and empty options', () => {
    setup()
    const mismatch = service.open(
      openInput({ detail: { kind: 'agent_blocker', text: 'stuck' } }),
      T0,
    )
    expect(mismatch.ok === false && mismatch.error.code === 'VALIDATION_FAILED').toBe(true)

    const noOptions = service.open(openInput({ dedupeKey: 'k:2', options: [] }), T0)
    expect(noOptions.ok === false && noOptions.error.code === 'VALIDATION_FAILED').toBe(true)
    expect(openedEvents).toHaveLength(0)
  })
})

describe('DecisionService.resolve (TASK-128)', () => {
  it('resolves via CAS, emits decision.resolved and notifies onResolved handlers', () => {
    setup()
    const handler = vi.fn()
    service.onResolved('shell_confirmation', handler)
    const opened = service.open(openInput(), T0)
    if (!opened.ok) throw new Error('open failed')

    const resolved = service.resolve(opened.data.id, 'approve', 'user', 'looks safe', T1)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.status).toBe('resolved')
    expect(resolved.data.resolution).toEqual({
      optionId: 'approve',
      decidedBy: 'user',
      decidedAt: T1,
      note: 'looks safe',
    })
    expect(resolved.data.resolvedAt).toBe(T1)
    expect(resolvedEvents.map((decision) => decision.status)).toEqual(['resolved'])
    // The service does not act itself — the source module's handler does.
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]?.[0]?.id).toBe(opened.data.id)
  })

  it('answers CONFLICT on the second resolve (CAS only succeeds once)', () => {
    setup()
    const opened = service.open(openInput(), T0)
    if (!opened.ok) throw new Error('open failed')

    expect(service.resolve(opened.data.id, 'approve', 'user', undefined, T1).ok).toBe(true)
    const second = service.resolve(opened.data.id, 'reject', 'user', undefined, T2)
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error.code).toBe('CONFLICT')
    expect(resolvedEvents).toHaveLength(1)
  })

  it('rejects unknown ids, unknown options and non-open rows', () => {
    setup()
    const opened = service.open(openInput(), T0)
    if (!opened.ok) throw new Error('open failed')

    const missing = service.resolve('dec-missing', 'approve', 'user')
    expect(missing.ok === false && missing.error.code === 'VALIDATION_FAILED').toBe(true)

    const badOption = service.resolve(opened.data.id, 'always_allow', 'user')
    expect(badOption.ok === false && badOption.error.code === 'VALIDATION_FAILED').toBe(true)

    service.resolve(opened.data.id, 'approve', 'user', undefined, T1)
    const closed = service.resolve(opened.data.id, 'approve', 'user', undefined, T2)
    expect(closed.ok === false && closed.error.code === 'CONFLICT').toBe(true)
  })
})

describe('DecisionService.expire (TASK-128, ADR-0014 §4)', () => {
  it('expires due rows with the kind default action and decidedBy timeout', () => {
    setup()
    const shellHandler = vi.fn()
    const stalledHandler = vi.fn()
    const blockerHandler = vi.fn()
    service.onResolved('shell_confirmation', shellHandler)
    service.onResolved('stalled_run', stalledHandler)
    service.onResolved('agent_blocker', blockerHandler)

    const shell = service.open(openInput({ timeoutMs: 60_000 }), T0)
    const stalled = service.open(
      openInput({
        kind: 'stalled_run',
        severity: 'warning',
        dedupeKey: 'stalled_run:run-1',
        runId: 'run-1',
        detail: { kind: 'stalled_run', silentForMs: 7_200_000 },
        options: [
          { id: 'keep_waiting', label: 'Keep waiting' },
          { id: 'stop', label: 'Stop', danger: true },
        ],
        timeoutMs: 60_000,
      }),
      T0,
    )
    const blocker = service.open(
      openInput({
        kind: 'agent_blocker',
        severity: 'warning',
        dedupeKey: 'agent_blocker:run-1',
        runId: 'run-1',
        detail: { kind: 'agent_blocker', text: 'Need input.' },
        options: [
          { id: 'acknowledge', label: 'Acknowledge' },
          { id: 'stop', label: 'Stop run', danger: true },
        ],
        timeoutMs: 60_000,
      }),
      T0,
    )
    if (!shell.ok || !stalled.ok || !blocker.ok) throw new Error('open failed')

    const expired = service.expire(T2)
    expect(expired.ok).toBe(true)
    if (!expired.ok) return
    expect(expired.data).toHaveLength(3)

    const byKind = new Map(expired.data.map((decision) => [decision.kind, decision]))
    // §9.1 default actions: shell 确认 = 拒绝、stalled_run = 继续等待、
    // agent_blocker = 无动作（引用其非破坏性选项，handler 不动 Run）。
    expect(byKind.get('shell_confirmation')?.resolution).toEqual({
      optionId: 'reject',
      decidedBy: 'timeout',
      decidedAt: T2,
    })
    expect(byKind.get('stalled_run')?.resolution?.optionId).toBe('keep_waiting')
    expect(byKind.get('agent_blocker')?.resolution?.optionId).toBe('acknowledge')
    expect(DECISION_TIMEOUT_DEFAULT_OPTIONS.agent_blocker).toBe('acknowledge')

    for (const handler of [shellHandler, stalledHandler, blockerHandler]) {
      expect(handler).toHaveBeenCalledTimes(1)
    }
    expect(resolvedEvents.map((decision) => decision.status)).toEqual([
      'expired',
      'expired',
      'expired',
    ])
  })

  it('leaves not-yet-due and never-expiring (timeout 0) rows open', () => {
    setup()
    const future = service.open(openInput({ timeoutMs: 3_600_000 }), T0)
    const eternal = service.open(openInput({ dedupeKey: 'k:2', timeoutMs: 0 }), T0)
    if (!future.ok || !eternal.ok) throw new Error('open failed')

    // Due at 01:00 — still open at 00:05; the timeout-0 row never expires.
    const expired = service.expire(T1)
    expect(expired).toEqual({ ok: true, data: [] })
    expect(service.get(future.data.id).ok).toBe(true)
    const remaining = service.list({ status: 'open' })
    expect(remaining.ok && remaining.data.length === 2).toBe(true)
  })

  it('expires each row only once; a resolved row is not re-closed', () => {
    setup()
    const opened = service.open(openInput({ timeoutMs: 60_000 }), T0)
    if (!opened.ok) throw new Error('open failed')
    service.resolve(opened.data.id, 'approve', 'user', undefined, T1)

    const expired = service.expire(T2)
    expect(expired).toEqual({ ok: true, data: [] })
    const current = service.get(opened.data.id)
    expect(current.ok && current.data?.status === 'resolved').toBe(true)
    expect(resolvedEvents).toHaveLength(1)
  })
})

describe('DecisionService.cancelBySource (TASK-128)', () => {
  it('cancels the open rows of a run and of a workflow run', () => {
    setup()
    const handler = vi.fn()
    service.onResolved('shell_confirmation', handler)
    const byRun = service.open(openInput({ runId: 'run-1' }), T0)
    const byWorkflowRun = service.open(openInput({ dedupeKey: 'k:2', workflowRunId: 'wfr-1' }), T0)
    const other = service.open(openInput({ dedupeKey: 'k:3' }), T0)
    if (!byRun.ok || !byWorkflowRun.ok || !other.ok) throw new Error('open failed')

    const cancelledRuns = service.cancelBySource({ runId: 'run-1' }, T1)
    expect(cancelledRuns.ok && cancelledRuns.data.map((decision) => decision.id)).toEqual([
      byRun.data.id,
    ])
    const cancelledWorkflow = service.cancelBySource({ workflowRunId: 'wfr-1' }, T1)
    expect(cancelledWorkflow.ok && cancelledWorkflow.data.map((decision) => decision.id)).toEqual([
      byWorkflowRun.data.id,
    ])

    const surviving = service.get(other.data.id)
    expect(surviving.ok && surviving.data?.status === 'open').toBe(true)
    // decision.resolved covers cancellations too — the status distinguishes.
    expect(resolvedEvents.map((decision) => decision.status)).toEqual(['cancelled', 'cancelled'])
    // The source tore itself down; no resolution action is dispatched.
    expect(handler).not.toHaveBeenCalled()
  })

  it('requires at least one source key', () => {
    setup()
    const result = service.cancelBySource({}, T1)
    expect(result.ok === false && result.error.code === 'VALIDATION_FAILED').toBe(true)
  })
})

describe('DecisionService.reconcileOnStartup (TASK-128, ADR-0014 §5)', () => {
  it('expires open shell confirmations with a persisted system-resolution audit trail', () => {
    setup()
    // Simulated restart: rows persist in the DB, the service (and every
    // in-memory step promise) is brand new.
    const stale = service.open(openInput(), T0)
    const stalled = service.open(
      openInput({
        kind: 'stalled_run',
        severity: 'warning',
        dedupeKey: 'stalled_run:run-1',
        detail: { kind: 'stalled_run', silentForMs: 60_000 },
        options: [{ id: 'keep_waiting', label: 'Keep waiting' }],
      }),
      T0,
    )
    if (!stale.ok || !stalled.ok) throw new Error('open failed')

    const restarted = createDecisionService({
      decisions: createDecisionRepository(connection),
      events,
    })
    const reconciled = restarted.reconcileOnStartup(T2)
    expect(reconciled.ok).toBe(true)
    if (!reconciled.ok) return
    expect(reconciled.data.map((decision) => decision.id)).toEqual([stale.data.id])

    const closed = restarted.get(stale.data.id)
    expect(closed.ok).toBe(true)
    if (!closed.ok) return
    expect(closed.data?.status).toBe('expired')
    // The persisted transition IS the audit record (ADR-0014 §5/§6).
    expect(closed.data?.resolution?.decidedBy).toBe('system')
    expect(closed.data?.resolution?.optionId).toBe('reject')
    expect(closed.data?.resolution?.note).toContain('restarted')

    // Other kinds keep their open rows — their source state lives in the DB.
    const surviving = restarted.get(stalled.data.id)
    expect(surviving.ok && surviving.data?.status === 'open').toBe(true)
    expect(resolvedEvents.map((decision) => decision.status)).toEqual(['expired'])

    // Reconciliation is idempotent: a second startup closes nothing.
    expect(restarted.reconcileOnStartup(T2)).toEqual({ ok: true, data: [] })

    // And the expired confirmation can never be approved anymore.
    const late = restarted.resolve(stale.data.id, 'approve', 'user', undefined, T2)
    expect(late.ok === false && late.error.code === 'CONFLICT').toBe(true)
  })
})
