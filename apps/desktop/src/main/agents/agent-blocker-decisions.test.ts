import Database from 'better-sqlite3'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentRun, IpcResult } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import { createEventBus } from '../events/event-bus'
import { createDecisionRepository } from '../decisions/decision-repository'
import { createDecisionService, type DecisionService } from '../decisions/decision-service'
import { createSendTaskMessageService } from '../tasks/send-message-service'
import {
  createAgentBlockerDecisionBridge,
  type AgentBlockerDecisionBridge,
  type AgentQuestionAnswer,
} from './agent-blocker-decisions'

/**
 * TASK-130 acceptance (teskra-tasks.md; design doc §9.2): blocker / question
 * progress events open an `agent_blocker` decision; `stop` cancels the run,
 * `acknowledge` is a no-op; the Run row is never touched by opening one.
 * TASK-139 (Milestone 26 §9.3): a question resolved with a note re-enters the
 * send-message flow — the note is the thread's next message.
 */

const T0 = '2026-09-22T00:00:00.000Z'

let connection: Database.Database | undefined
let decisions: DecisionService
let bridge: AgentBlockerDecisionBridge
let cancel: ReturnType<typeof vi.fn<(runId: string) => Promise<IpcResult<AgentRun>>>>
let answer:
  ReturnType<typeof vi.fn<(input: AgentQuestionAnswer) => Promise<IpcResult<unknown>>>> | undefined
let runGone: boolean
let runTaskId: string | undefined

function setup(options: { withAnswer?: boolean } = {}) {
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
  runTaskId = 'task-1'
  answer =
    options.withAnswer === true ? vi.fn(async () => ({ ok: true as const, data: {} })) : undefined
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
                ...(runTaskId === undefined ? {} : { taskId: runTaskId }),
              } as AgentRun,
            },
    },
    agents: { cancel },
    ...(answer === undefined ? {} : { answer }),
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

describe('AgentBlockerDecisionBridge question answers (TASK-139)', () => {
  function reportQuestion() {
    bridge.report('run-1', { kind: 'question', message: 'Should I use Vitest or Jest?' })
    const open = openBlockerDecisions()
    const decision = open[0]
    if (decision === undefined) throw new Error('expected an open question decision')
    return decision
  }

  it('a question resolved with a note stores resolution.note and forwards the answer to the message flow', async () => {
    setup({ withAnswer: true })
    const decision = reportQuestion()

    const resolved = decisions.resolve(decision.id, 'acknowledge', 'user', 'Use Vitest.')

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.resolution?.note).toBe('Use Vitest.')
    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1))
    expect(answer).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      text: 'Use Vitest.',
    })
    expect(cancel).not.toHaveBeenCalled()
  })

  it('a blocker (warning) resolved with a note never enters the message flow', async () => {
    setup({ withAnswer: true })
    bridge.report('run-1', { kind: 'blocker', message: 'Need access' })
    const open = openBlockerDecisions()
    const decision = open[0]
    if (decision === undefined) throw new Error('unreachable')

    decisions.resolve(decision.id, 'acknowledge', 'user', 'granted manually')

    await Promise.resolve()
    expect(answer).not.toHaveBeenCalled()
  })

  it('a question acknowledged WITHOUT a note, or closed by the system, is not an answer', async () => {
    setup({ withAnswer: true })
    const first = reportQuestion()
    decisions.resolve(first.id, 'acknowledge', 'user')
    await Promise.resolve()
    expect(answer).not.toHaveBeenCalled()

    const second = reportQuestion()
    decisions.resolve(second.id, 'acknowledge', 'system', 'auto-closed')
    await Promise.resolve()
    expect(answer).not.toHaveBeenCalled()
  })

  it('an answer whose run is gone (or taskless) is dropped without throwing', async () => {
    setup({ withAnswer: true })
    runTaskId = undefined
    const decision = reportQuestion()

    decisions.resolve(decision.id, 'acknowledge', 'user', 'Use Vitest.')

    await Promise.resolve()
    expect(answer).not.toHaveBeenCalled()
  })

  it('end-to-end: the answer note becomes the next send-message round', async () => {
    setup()
    // The composed wiring (compose.ts): the bridge's answer callback IS
    // SendTaskMessageService.sendMessage. Rebuild the bridge with that
    // callback (the setup() bridge has none).
    bridge.dispose()
    const starts: unknown[] = []
    const service = createSendTaskMessageService({
      tasks: {
        create: vi.fn(() => {
          throw new Error('the task already exists')
        }),
        get: vi.fn((id: string) => ({
          ok: true as const,
          data:
            id === 'task-1'
              ? {
                  id: 'task-1',
                  workspaceId: 'ws-1',
                  title: 'Thread',
                  status: 'ready' as const,
                  createdAt: T0,
                  updatedAt: T0,
                }
              : null,
        })),
      },
      defaults: {
        resolveDefaults: vi.fn(async () => ({
          ok: true as const,
          data: {
            agentType: 'fake',
            mode: 'exec' as const,
            executionMode: 'orchestrated' as const,
            approvalMode: 'safe-auto' as const,
            isolation: 'worktree' as const,
            reasons: [],
          },
        })),
      },
      worktreeManager: {
        create: vi.fn(async () => ({
          ok: true as const,
          data: {
            id: 'wt-new',
            workspaceId: 'ws-1',
            branch: 'agent/task-1/fake/run-new',
            baseBranch: 'main',
            path: '/data/worktrees/ws-1/run-new',
            state: 'ready' as const,
            isolation: 'worktree' as const,
            createdAt: T0,
            updatedAt: T0,
          },
        })),
        discard: vi.fn(),
      },
      agents: {
        start: vi.fn(async (request: unknown) => {
          starts.push(request)
          return {
            ok: true as const,
            data: { id: 'run-new', status: 'running' } as AgentRun,
          }
        }),
        continueWithProfile: vi.fn(),
      },
      reviewer: { startReview: vi.fn() },
      fullWorkflow: { start: vi.fn() },
      profileAliases: { resolveAgentNodeProfiles: vi.fn() },
      accountProfiles: { getById: vi.fn(() => ({ ok: true as const, data: null })) },
      // No prior runs on the task → the answer starts a fresh round.
      runs: {
        listByTask: vi.fn(() => ({ ok: true as const, data: [] })),
        listActive: vi.fn(() => ({ ok: true as const, data: [] })),
      },
      worktrees: { getById: vi.fn(() => ({ ok: true as const, data: null })) },
    })
    bridge = createAgentBlockerDecisionBridge({
      decisions,
      runs: {
        getById: (id) =>
          id !== 'run-1'
            ? { ok: true as const, data: null }
            : {
                ok: true as const,
                data: {
                  id: 'run-1',
                  workspaceId: 'ws-1',
                  status: 'running',
                  taskId: 'task-1',
                } as AgentRun,
              },
      },
      agents: { cancel },
      answer: (input) =>
        service.sendMessage({
          workspaceId: input.workspaceId,
          taskId: input.taskId,
          text: input.text,
        }),
    })
    const decision = reportQuestion()

    const resolved = decisions.resolve(decision.id, 'acknowledge', 'user', 'Use Vitest.')

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.resolution?.note).toBe('Use Vitest.')
    await vi.waitFor(() => expect(starts).toHaveLength(1))
    expect(starts[0]).toMatchObject({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      agentType: 'fake',
      mode: 'exec',
      prompt: 'Use Vitest.',
    })
  })
})
