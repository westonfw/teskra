import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import type { PendingDecision, WorkbenchEvents } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import { createDecisionRepository } from '../decisions/decision-repository'
import { createDecisionService, type DecisionService } from '../decisions/decision-service'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createShellConfirmationService, type ShellConfirmationService } from './shell-confirmation'

// Silence the pino file/stdout logger (getLogger reads this lazily).
process.env['TESKRA_LOG_LEVEL'] = 'fatal'

/**
 * TASK-118: the shell-confirmation gate parks a repo-defined shell step until
 * the user answers; cancellation and shutdown never leave it hanging.
 *
 * TASK-129 (ADR-0014): the gate is backed by the persisted Decision Inbox —
 * the tests run the real stack (in-memory SQLite through migrateDatabase, the
 * real DecisionRepository / DecisionService / EventBus); only the decision id
 * generator is faked.
 */

const T0 = '2026-09-22T00:00:00.000Z'

interface Harness {
  readonly connection: Database.Database
  readonly events: EventBus<WorkbenchEvents>
  readonly decisions: DecisionService
  readonly service: ShellConfirmationService
  readonly openedEvents: PendingDecision[]
  readonly resolvedEvents: PendingDecision[]
}

const connections: Database.Database[] = []

function setup(options: { timeoutMs?: number } = {}): Harness {
  const connection = new Database(':memory:')
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
      `INSERT INTO workflow_runs (id, task_id, workflow_definition_id, definition_json, status, created_at)
       VALUES ('run-1', NULL, 'def', '{}', 'running', '${T0}')`,
    )
    .run()
  for (const stepId of ['step-1', 'step-2']) {
    connection
      .prepare(
        `INSERT INTO workflow_steps (id, workflow_run_id, node_id, node_type, status, created_at)
         VALUES ('${stepId}', 'run-1', 'test-implement', 'shell', 'running', '${T0}')`,
      )
      .run()
  }
  connections.push(connection)
  const events = createEventBus<WorkbenchEvents>()
  const openedEvents: PendingDecision[] = []
  const resolvedEvents: PendingDecision[] = []
  events.subscribe('decision.opened', ({ decision }) => openedEvents.push(decision))
  events.subscribe('decision.resolved', ({ decision }) => resolvedEvents.push(decision))
  let sequence = 0
  const decisions = createDecisionService({
    decisions: createDecisionRepository(connection),
    events,
    createId: () => `dec-${++sequence}`,
  })
  const service = createShellConfirmationService({
    events,
    decisions,
    resolveTimeoutMs: () => options.timeoutMs ?? 0,
  })
  return { connection, events, decisions, service, openedEvents, resolvedEvents }
}

afterEach(() => {
  while (connections.length > 0) {
    connections.pop()?.close()
  }
})

describe('ShellConfirmationService (TASK-118)', () => {
  const details = {
    workspaceId: 'ws-1',
    runId: 'run-1',
    stepId: 'step-1',
    nodeId: 'test-implement',
    command: 'npm run repo-script',
    cwd: '/repo',
  }

  it('emits the full command line and parks until resolve approves', async () => {
    const { events, service } = setup()
    const emitted: WorkbenchEvents['workflow.shell_confirmation_required'][] = []
    events.subscribe('workflow.shell_confirmation_required', (payload) => emitted.push(payload))

    let settled: boolean | undefined
    const parked = service.request(details).then((approved) => {
      settled = approved
    })
    // The event went out synchronously; the promise has not settled.
    expect(emitted).toEqual([
      {
        runId: details.runId,
        stepId: details.stepId,
        nodeId: details.nodeId,
        command: details.command,
        cwd: details.cwd,
      },
    ])
    await Promise.resolve()
    expect(settled).toBeUndefined()

    const resolved = service.resolve('step-1', true)
    expect(resolved).toEqual({ ok: true, data: true })
    await parked
    expect(settled).toBe(true)
  })

  it('rejects the step when the user declines', async () => {
    const { service } = setup()
    const parked = service.request(details)
    expect(service.resolve('step-1', false)).toEqual({ ok: true, data: true })
    await expect(parked).resolves.toBe(false)
  })

  it('reports an unknown step instead of hanging a second answer', async () => {
    const { service } = setup()
    const result = service.resolve('step-nope', true)
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('cancel settles the pending request as rejected', async () => {
    const { decisions, service } = setup()
    const parked = service.request(details)
    service.cancel('step-1')
    await expect(parked).resolves.toBe(false)
    expect(service.listPending()).toEqual([])
    // TASK-129: cancel routes through the decision channel — the persisted
    // row leaves `open` as cancelled (no resolution action is dispatched).
    const open = decisions.list({ kind: 'shell_confirmation', status: 'open' })
    expect(open).toEqual({ ok: true, data: [] })
    const closed = decisions.get('dec-1')
    expect(closed.ok && closed.data?.status === 'cancelled').toBe(true)
  })

  it('lists parked confirmations so a (re)subscribing host can pull the backlog', async () => {
    const { service } = setup()
    expect(service.listPending()).toEqual([])

    const first = service.request(details)
    const secondDetails = { ...details, stepId: 'step-2', command: 'npm run other-script' }
    const second = service.request(secondDetails)
    // A host that mounted after both events fired still sees both pending items.
    expect(service.listPending()).toEqual([details, secondDetails])

    service.resolve('step-1', true)
    await expect(first).resolves.toBe(true)
    expect(service.listPending()).toEqual([secondDetails])

    service.cancel('step-2')
    await expect(second).resolves.toBe(false)
    expect(service.listPending()).toEqual([])
  })

  it('dispose rejects every parked request', async () => {
    const { service } = setup()
    const first = service.request(details)
    const second = service.request({ ...details, stepId: 'step-2' })
    service.dispose()
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
  })
})

describe('ShellConfirmationService — Decision Inbox backing (TASK-129, ADR-0014)', () => {
  const details = {
    workspaceId: 'ws-1',
    runId: 'run-1',
    stepId: 'step-1',
    nodeId: 'test-implement',
    command: 'npm run repo-script',
    cwd: '/repo',
  }

  it('request() persists an open shell_confirmation decision before parking', async () => {
    const { decisions, service, openedEvents } = setup()
    const parked = service.request(details)

    const open = decisions.list({ kind: 'shell_confirmation', status: 'open' })
    expect(open.ok && open.data.length === 1).toBe(true)
    const row = open.ok ? open.data[0] : undefined
    expect(row).toMatchObject({
      workspaceId: 'ws-1',
      kind: 'shell_confirmation',
      status: 'open',
      severity: 'blocking',
      dedupeKey: 'step-1',
      workflowRunId: 'run-1',
      workflowStepId: 'step-1',
      detail: { kind: 'shell_confirmation', command: 'npm run repo-script', cwd: '/repo' },
    })
    // §9.2 vocabulary; there is no "always allow" option (ADR-0014 §7).
    expect(row?.options.map((option) => option.id)).toEqual(['approve', 'reject'])
    // Timeout 0 (the default) never expires.
    expect(row?.expiresAt).toBeUndefined()
    // decision.opened fired alongside the compat event, exactly once.
    expect(openedEvents.map((decision) => decision.id)).toEqual([row?.id])

    service.dispose()
    await expect(parked).resolves.toBe(false)
  })

  it('a resolution straight through the decision channel settles the parked step', async () => {
    const { decisions, service } = setup()
    const parked = service.request(details)
    const open = decisions.list({ kind: 'shell_confirmation', status: 'open' })
    if (!open.ok || open.data[0] === undefined) throw new Error('open failed')

    // The Inbox answers via teskra:decision:resolve — no compat alias involved.
    const resolved = decisions.resolve(open.data[0].id, 'approve', 'user')
    expect(resolved.ok).toBe(true)
    await expect(parked).resolves.toBe(true)
    expect(service.listPending()).toEqual([])
  })

  it('resolve() answers through the decision channel (CAS resolution is persisted)', async () => {
    const { decisions, service } = setup()
    const parked = service.request(details)
    expect(service.resolve('step-1', true)).toEqual({ ok: true, data: true })
    await expect(parked).resolves.toBe(true)

    const row = decisions.get('dec-1')
    expect(row.ok && row.data?.status === 'resolved').toBe(true)
    expect(row.ok && row.data?.resolution?.optionId).toBe('approve')
    expect(row.ok && row.data?.resolution?.decidedBy).toBe('user')
  })

  it('a configured timeout expires the confirmation, refuses the step and audits it', async () => {
    const { decisions, service, resolvedEvents } = setup({ timeoutMs: 60_000 })
    const parked = service.request(details)

    const open = decisions.list({ kind: 'shell_confirmation', status: 'open' })
    if (!open.ok || open.data[0] === undefined) throw new Error('open failed')
    // decisions.shellConfirmationTimeoutMs > 0 → the row carries an expiresAt.
    expect(open.data[0].expiresAt).toBeDefined()
    const afterExpiry = new Date(Date.parse(open.data[0].expiresAt as string) + 1000).toISOString()

    // The watchdog tick drives expire(); the kind default action is reject.
    const expired = decisions.expire(afterExpiry)
    expect(expired.ok && expired.data.map((decision) => decision.id)).toEqual([open.data[0].id])
    await expect(parked).resolves.toBe(false)
    expect(service.listPending()).toEqual([])

    // The persisted transition is the audit record: rejected by timeout.
    const row = decisions.get(open.data[0].id)
    expect(row.ok && row.data?.status).toBe('expired')
    expect(row.ok && row.data?.resolution).toMatchObject({
      optionId: 'reject',
      decidedBy: 'timeout',
    })
    expect(resolvedEvents.map((decision) => decision.status)).toEqual(['expired'])
  })

  it('after a restart an open confirmation can never be approved (VALIDATION_FAILED)', async () => {
    const harness = setup()
    const parked = harness.service.request(details)

    // Simulated restart: the row persists, the service (and with it the
    // in-memory step promise) is brand new; startup reconciliation expires
    // the still-open confirmation with a system audit note.
    harness.service.dispose()
    await expect(parked).resolves.toBe(false)
    const restartedDecisions = createDecisionService({
      decisions: createDecisionRepository(harness.connection),
      events: harness.events,
      createId: () => 'dec-restarted',
    })
    const restarted = createShellConfirmationService({
      events: harness.events,
      decisions: restartedDecisions,
    })

    const reconciled = restartedDecisions.reconcileOnStartup()
    expect(reconciled.ok && reconciled.data.map((decision) => decision.id)).toEqual(['dec-1'])
    const row = restartedDecisions.get('dec-1')
    expect(row.ok && row.data?.status).toBe('expired')
    expect(row.ok && row.data?.resolution).toMatchObject({
      optionId: 'reject',
      decidedBy: 'system',
    })

    // The step's promise did not survive — approval is impossible from both
    // the compat alias and the decision channel.
    const viaAlias = restarted.resolve('step-1', true)
    expect(viaAlias).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    const viaDecisionChannel = restartedDecisions.resolve('dec-1', 'approve', 'user')
    expect(viaDecisionChannel).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    restarted.dispose()
  })
})
