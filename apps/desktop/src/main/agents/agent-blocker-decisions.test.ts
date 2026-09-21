import Database from 'better-sqlite3'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentRun, IpcResult } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import { createEventBus } from '../events/event-bus'
import { createDecisionRepository } from '../decisions/decision-repository'
import { createDecisionService, type DecisionService } from '../decisions/decision-service'
import {
  createAgentBlockerDecisionBridge,
  type AgentBlockerDecisionBridge,
} from './agent-blocker-decisions'

/**
 * TASK-130 acceptance (teskra-tasks.md; design doc §9.2): blocker / question
 * progress events open an `agent_blocker` decision; `stop` cancels the run,
 * `acknowledge` is a no-op; the Run row is never touched by opening one.
 */

const T0 = '2026-09-22T00:00:00.000Z'

let connection: Database.Database | undefined
let decisions: DecisionService
let bridge: AgentBlockerDecisionBridge
let cancel: ReturnType<typeof vi.fn<(runId: string) => Promise<IpcResult<AgentRun>>>>
let runGone: boolean

function setup() {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  connection
    .prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', '${T0}', '${T0}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
       VALUES ('run-1', 'ws-1', 'fake', 'running', 'attended', 'runs/run-1', '${T0}', '${T0}')`,
    )
    .run()
  decisions = createDecisionService({
    decisions: createDecisionRepository(connection),
    events: createEventBus(),
  })
  cancel = vi.fn(async (runId: string) => ({
    ok: true as const,
    data: { id: runId, status: 'cancelled' } as AgentRun,
  }))
  runGone = false
  bridge = createAgentBlockerDecisionBridge({
    decisions,
    runs: {
      getById: (id) =>
        runGone || id !== 'run-1'
          ? { ok: true as const, data: null }
          : {
              ok: true as const,
              data: {
                id: 'run-1',
                workspaceId: 'ws-1',
                status: 'running',
              } as AgentRun,
            },
    },
    agents: { cancel },
  })
}

afterEach(() => {
  bridge.dispose()
  decisions.dispose()
  connection?.close()
  connection = undefined
})

function openBlockerDecisions() {
  const listed = decisions.list({ kind: 'agent_blocker', status: 'open' })
  if (!listed.ok) throw new Error(listed.error.message)
  return listed.data
}

describe('AgentBlockerDecisionBridge (TASK-130)', () => {
  it('opens a warning decision for a blocker; stop cancels the run', async () => {
    setup()
    bridge.report('run-1', { kind: 'blocker', message: 'Need access to the billing API' })

    const open = openBlockerDecisions()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({
      workspaceId: 'ws-1',
      kind: 'agent_blocker',
      severity: 'warning',
      runId: 'run-1',
      detail: { kind: 'agent_blocker', text: 'Need access to the billing API' },
      options: [
        { id: 'acknowledge', label: 'Acknowledge' },
        { id: 'stop', label: 'Stop the run' },
      ],
    })
    const decision = open[0]
    if (decision === undefined) throw new Error('unreachable')

    const resolved = decisions.resolve(decision.id, 'stop', 'user')
    expect(resolved.ok).toBe(true)
    // The cancel promise settles on the microtask queue.
    await Promise.resolve()
    expect(cancel).toHaveBeenCalledWith('run-1')
  })

  it('opens an info decision for a question; acknowledge performs no run action', async () => {
    setup()
    bridge.report('run-1', { kind: 'question', message: 'Should I use Vitest or Jest?' })

    const open = openBlockerDecisions()
    expect(open).toHaveLength(1)
    expect(open[0]?.severity).toBe('info')
    const decision = open[0]
    if (decision === undefined) throw new Error('unreachable')

    const resolved = decisions.resolve(decision.id, 'acknowledge', 'user')
    expect(resolved.ok).toBe(true)
    await Promise.resolve()
    expect(cancel).not.toHaveBeenCalled()
    // Opening the decision never touched the run: it is still running.
    expect(runGone).toBe(false)
  })

  it('ignores non-blocker progress kinds and dedupes a repeated blocker while open', () => {
    setup()
    bridge.report('run-1', { kind: 'progress', message: 'Half done', percent: 50 })
    expect(openBlockerDecisions()).toHaveLength(0)

    bridge.report('run-1', { kind: 'blocker', message: 'Waiting on credentials' })
    bridge.report('run-1', { kind: 'blocker', message: 'Waiting on credentials' })
    expect(openBlockerDecisions()).toHaveLength(1)
  })

  it('opens nothing when the reporting run no longer exists', () => {
    setup()
    runGone = true
    bridge.report('run-1', { kind: 'blocker', message: 'Too late' })
    expect(openBlockerDecisions()).toHaveLength(0)
  })
})
