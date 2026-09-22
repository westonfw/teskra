import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  IpcResult,
  TaskThreadResponse,
  ThreadItem,
  WorkflowDefinition,
} from '@teskra/contracts'
import { AGENT_REPLY_TEXT_MAX, TERMINAL_REPLY_TAIL_MAX } from '@teskra/contracts'

import { createDecisionRepository } from '../decisions/decision-repository'
import { migrateDatabase } from '../db/migrations'
import { createAgentEventRepository } from '../db/repositories/agent-event-repository'
import { createAgentRunRepository } from '../db/repositories/agent-run-repository'
import { createHandoffRepository } from '../db/repositories/handoff-repository'
import { createWorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import type { RunPaths } from '../paths'
import { createThreadProjection, type ThreadProjection } from './thread-projection'

const T0 = '2026-09-23T00:00:00.000Z'
const T1 = '2026-09-23T00:01:00.000Z'
const T2 = '2026-09-23T00:02:00.000Z'
const T3 = '2026-09-23T00:03:00.000Z'

const WORKFLOW_DEFINITION: WorkflowDefinition = {
  id: 'full',
  steps: [{ id: 'implement', type: 'agent', agent: 'codex', runOn: 'first' }],
}

interface Fixture {
  readonly connection: Database.Database
  readonly projection: ThreadProjection
  readonly runs: ReturnType<typeof createAgentRunRepository>
  readonly events: ReturnType<typeof createAgentEventRepository>
  readonly handoffs: ReturnType<typeof createHandoffRepository>
  readonly workflowRuns: ReturnType<typeof createWorkflowRunRepository>
  readonly decisions: ReturnType<typeof createDecisionRepository>
  readonly terminalLogPath: (runId: string) => string
  readonly writeTerminalLog: (runId: string, content: string) => void
  readonly filesRoot: string
  readonly databaseFile?: string
}

const fixtures: Fixture[] = []

function runPaths(directory: string): RunPaths {
  return {
    directory,
    manifest: join(directory, 'run.json'),
    events: join(directory, 'events.jsonl'),
    terminal: join(directory, 'terminal.log'),
    handoff: join(directory, 'handoff.json'),
    diff: join(directory, 'diff.patch'),
    artifacts: join(directory, 'artifacts'),
    progress: join(directory, 'progress.jsonl'),
  }
}

function setup(options: { databaseFile?: string } = {}): Fixture {
  const connection =
    options.databaseFile === undefined
      ? new Database(':memory:')
      : new Database(options.databaseFile)
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
      `INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at)
       VALUES ('task-1', 'ws-1', 'T', 'ready', '${T0}', '${T0}')`,
    )
    .run()

  const runs = createAgentRunRepository(connection)
  const events = createAgentEventRepository(connection)
  const handoffs = createHandoffRepository(connection)
  const workflowRuns = createWorkflowRunRepository(connection)
  const decisions = createDecisionRepository(connection)

  const filesRoot = mkdtempSync(join(tmpdir(), 'teskra-thread-'))
  const terminalLogPath = (runId: string): string => join(filesRoot, runId, 'terminal.log')
  const writeTerminalLog = (runId: string, content: string): void => {
    mkdirSync(join(filesRoot, runId), { recursive: true })
    writeFileSync(terminalLogPath(runId), content, 'utf8')
  }
  const projection = createThreadProjection({
    runs,
    workflowRuns,
    handoffs,
    agentEvents: events,
    decisions,
    paths: {
      runFiles: (runId: string): IpcResult<RunPaths> => ({
        ok: true,
        data: runPaths(join(filesRoot, runId)),
      }),
    },
  })

  const fixture: Fixture = {
    connection,
    projection,
    runs,
    events,
    handoffs,
    workflowRuns,
    decisions,
    terminalLogPath,
    writeTerminalLog,
    filesRoot,
    ...(options.databaseFile === undefined ? {} : { databaseFile: options.databaseFile }),
  }
  fixtures.push(fixture)
  return fixture
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.connection.open) {
      fixture.connection.close()
    }
    rmSync(fixture.filesRoot, { recursive: true, force: true })
  }
})

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  return result.data
}

function createRun(
  fixture: Fixture,
  id: string,
  overrides: Record<string, unknown> = {},
  now = T0,
) {
  return requireOk(
    fixture.runs.create(
      {
        id,
        workspaceId: 'ws-1',
        taskId: 'task-1',
        agentType: 'codex',
        executionMode: 'orchestrated',
        mode: 'exec',
        runDir: `runs/${id}`,
        status: 'completed',
        ...overrides,
      },
      now,
    ),
  )
}

function appendObservation(fixture: Fixture, runId: string, seq: number, text: string, now = T1) {
  return requireOk(
    fixture.events.append(
      {
        runId,
        seq,
        eventType: 'agent.observation',
        payload: { kind: 'assistant_text', text },
      },
      now,
    ),
  )
}

function getThread(fixture: Fixture, request: Record<string, unknown> = {}): TaskThreadResponse {
  return requireOk(fixture.projection.getThread({ taskId: 'task-1', ...request }))
}

function itemsOfKind<K extends ThreadItem['kind']>(
  items: readonly ThreadItem[],
  kind: K,
): Extract<ThreadItem, { kind: K }>[] {
  return items.filter((item): item is Extract<ThreadItem, { kind: K }> => item.kind === kind)
}

describe('ThreadProjection (TASK-138)', () => {
  it('projects a run prompt as a user_message item', () => {
    const fixture = setup()
    createRun(fixture, 'run-1', { prompt: 'Fix the login page' })

    const thread = getThread(fixture)
    const messages = itemsOfKind(thread.items, 'user_message')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'user:run-1',
      runId: 'run-1',
      text: 'Fix the login page',
      createdAt: T0,
    })
  })

  it('joins assistant_text observations by seq into an agent_reply (source observation)', () => {
    const fixture = setup()
    createRun(fixture, 'run-1', { prompt: 'hi' })
    appendObservation(fixture, 'run-1', 1, 'Hello ', T1)
    appendObservation(fixture, 'run-1', 2, 'world', T2)
    // Non-assistant observations do not leak into the reply body.
    requireOk(
      fixture.events.append(
        {
          runId: 'run-1',
          seq: 3,
          eventType: 'agent.observation',
          payload: {
            kind: 'usage',
            inputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
        T3,
      ),
    )

    const replies = itemsOfKind(getThread(fixture).items, 'agent_reply')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({
      id: 'reply:run-1',
      text: 'Hello world',
      source: 'observation',
      truncated: false,
      createdAt: T2,
    })
  })

  it('caps the joined reply at 32 KiB and marks it truncated', () => {
    const fixture = setup()
    createRun(fixture, 'run-1', { prompt: 'hi' })
    // 5 × 7 000 chars (each under the 8 KiB per-observation cap) = 35 000 > 32 KiB.
    for (let seq = 1; seq <= 5; seq += 1) {
      appendObservation(fixture, 'run-1', seq, 'x'.repeat(7_000), T1)
    }

    const replies = itemsOfKind(getThread(fixture).items, 'agent_reply')
    expect(replies).toHaveLength(1)
    expect(replies[0]?.text).toHaveLength(AGENT_REPLY_TEXT_MAX)
    expect(replies[0]?.truncated).toBe(true)
    expect(replies[0]?.source).toBe('observation')
  })

  it('falls back to the handoff summary when there is no structured stream (source handoff)', () => {
    const fixture = setup()
    createRun(fixture, 'run-1', { prompt: 'hi' })
    requireOk(
      fixture.handoffs.save(
        {
          id: 'ho-1',
          runId: 'run-1',
          type: 'analysis',
          payload: { summary: 'Implemented the fix.' },
          parseStatus: 'missing',
        },
        T2,
      ),
    )

    const replies = itemsOfKind(getThread(fixture).items, 'agent_reply')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({
      text: 'Implemented the fix.',
      source: 'handoff',
      truncated: false,
      createdAt: T2,
    })
  })

  it("keeps the collector's terminal.log marker as source terminal", () => {
    const fixture = setup()
    createRun(fixture, 'run-1', { prompt: 'hi' })
    requireOk(
      fixture.handoffs.save(
        {
          id: 'ho-1',
          runId: 'run-1',
          type: 'analysis',
          payload: { source: 'terminal.log', summary: 'raw terminal tail' },
          parseStatus: 'missing',
        },
        T2,
      ),
    )

    const replies = itemsOfKind(getThread(fixture).items, 'agent_reply')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ text: 'raw terminal tail', source: 'terminal' })
  })

  it('falls back to the terminal.log tail (2 000 chars) when no stream and no handoff exist', () => {
    const fixture = setup()
    createRun(fixture, 'run-1', { prompt: 'hi' }, T0)
    const log = `${'A'.repeat(1_500)}${'B'.repeat(1_500)}`
    fixture.writeTerminalLog('run-1', log)

    const replies = itemsOfKind(getThread(fixture).items, 'agent_reply')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({
      text: log.slice(-TERMINAL_REPLY_TAIL_MAX).trim(),
      source: 'terminal',
      truncated: false,
    })
    expect(replies[0]?.text).toHaveLength(TERMINAL_REPLY_TAIL_MAX)
  })

  it('projects agent.progress events as agent_progress items', () => {
    const fixture = setup()
    createRun(fixture, 'run-1', { prompt: 'hi' })
    requireOk(
      fixture.events.append(
        {
          runId: 'run-1',
          seq: 1,
          eventType: 'agent.progress',
          payload: { kind: 'progress', message: 'Halfway there', percent: 50 },
        },
        T1,
      ),
    )

    const progress = itemsOfKind(getThread(fixture).items, 'agent_progress')
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({
      runId: 'run-1',
      createdAt: T1,
      event: { kind: 'progress', message: 'Halfway there', percent: 50 },
    })
  })

  it('projects open and resolved decisions with kind / severity / status / options / resolution', () => {
    const fixture = setup()
    createRun(fixture, 'run-1', { prompt: 'hi' })
    requireOk(
      fixture.decisions.insert(
        {
          id: 'dec-open',
          workspaceId: 'ws-1',
          kind: 'agent_blocker',
          severity: 'blocking',
          dedupeKey: 'agent_blocker:run-1',
          title: 'The Agent is blocked',
          detail: { kind: 'agent_blocker', text: 'Which test runner?' },
          options: [{ id: 'answer', label: 'Answer' }],
          runId: 'run-1',
        },
        T1,
      ),
    )
    requireOk(
      fixture.decisions.insert(
        {
          id: 'dec-resolved',
          workspaceId: 'ws-1',
          kind: 'handoff_degraded',
          severity: 'warning',
          dedupeKey: 'handoff_degraded:run-1',
          title: 'Handoff failed validation',
          detail: { kind: 'handoff_degraded', rawPath: '/tmp/handoff.json' },
          options: [{ id: 'dismiss', label: 'Dismiss' }],
          runId: 'run-1',
        },
        T2,
      ),
    )
    requireOk(
      fixture.decisions.closeOpen(
        'dec-resolved',
        {
          status: 'resolved',
          resolution: { optionId: 'dismiss', decidedBy: 'user', decidedAt: T3 },
        },
        T3,
      ),
    )

    const decisions = itemsOfKind(getThread(fixture).items, 'decision')
    expect(decisions).toHaveLength(2)
    expect(decisions[0]).toMatchObject({
      decisionId: 'dec-open',
      runId: 'run-1',
      decisionKind: 'agent_blocker',
      severity: 'blocking',
      status: 'open',
      options: [{ id: 'answer', label: 'Answer' }],
    })
    expect(decisions[0]?.resolution).toBeUndefined()
    expect(decisions[1]).toMatchObject({
      decisionId: 'dec-resolved',
      decisionKind: 'handoff_degraded',
      status: 'resolved',
      resolution: { optionId: 'dismiss', decidedBy: 'user', decidedAt: T3 },
    })
  })

  it('projects review runs, workflow runs and status changes as system items', () => {
    const fixture = setup()
    createRun(fixture, 'run-review', { prompt: 'review this', role: 'reviewer' }, T0)
    createRun(fixture, 'run-failed', { prompt: 'hi', status: 'failed' }, T1)
    requireOk(
      fixture.workflowRuns.createRun(
        {
          id: 'wf-1',
          taskId: 'task-1',
          workflowDefinitionId: 'full',
          definition: WORKFLOW_DEFINITION,
          status: 'running',
        },
        T2,
      ),
    )
    // Workflow-owned runs fold into the workflow card — no per-run items.
    createRun(fixture, 'run-in-wf', { prompt: 'step prompt', workflowRunId: 'wf-1' }, T3)

    const thread = getThread(fixture)
    const system = itemsOfKind(thread.items, 'system')
    expect(system.map((item) => item.systemKind).sort()).toEqual(['review', 'status', 'workflow'])
    expect(system.find((item) => item.systemKind === 'review')).toMatchObject({
      runId: 'run-review',
      status: 'completed',
    })
    expect(system.find((item) => item.systemKind === 'status')).toMatchObject({
      runId: 'run-failed',
      status: 'failed',
    })
    expect(system.find((item) => item.systemKind === 'workflow')).toMatchObject({
      workflowRunId: 'wf-1',
      status: 'running',
    })
    // The reviewer run and the workflow-owned run produced no user_message.
    expect(itemsOfKind(thread.items, 'user_message').map((item) => item.runId)).toEqual([
      'run-failed',
    ])
  })

  it('collapses an interactive run into a single linked terminal system item (TASK-140)', () => {
    const fixture = setup()
    createRun(fixture, 'run-tui', { prompt: 'drive the TUI', mode: 'interactive' }, T0)
    // A pre-ADR-0007 row without a persisted mode is interactive as well.
    createRun(fixture, 'run-legacy', { prompt: 'legacy', mode: null, status: 'failed' }, T1)

    const thread = getThread(fixture)
    const system = itemsOfKind(thread.items, 'system')
    expect(system.map((item) => item.id).sort()).toEqual([
      'system:terminal:run-legacy',
      'system:terminal:run-tui',
    ])
    expect(system.find((item) => item.runId === 'run-tui')).toMatchObject({
      systemKind: 'terminal',
      status: 'completed',
    })
    expect(system.find((item) => item.runId === 'run-legacy')).toMatchObject({
      systemKind: 'terminal',
      status: 'failed',
    })
    // Neither the prompt nor the terminal status change produce extra items.
    expect(itemsOfKind(thread.items, 'user_message')).toEqual([])
  })

  it('paginates stably on (createdAt, id) when items share a timestamp', () => {
    const fixture = setup()
    createRun(fixture, 'run-a', { prompt: 'first' }, T0)
    createRun(fixture, 'run-b', { prompt: 'second' }, T0)
    createRun(fixture, 'run-c', { prompt: 'third' }, T0)

    const page1 = getThread(fixture, { limit: 1 })
    expect(page1.items.map((item) => item.id)).toEqual(['user:run-a'])
    expect(page1.nextCursor).toBe(`${T0}|user:run-a`)

    const page2 = getThread(fixture, { limit: 1, afterCursor: page1.nextCursor })
    expect(page2.items.map((item) => item.id)).toEqual(['user:run-b'])
    expect(page2.nextCursor).toBe(`${T0}|user:run-b`)

    const page3 = getThread(fixture, { limit: 1, afterCursor: page2.nextCursor })
    expect(page3.items.map((item) => item.id)).toEqual(['user:run-c'])
    expect(page3.nextCursor).toBeUndefined()

    // No overlap and no loss across the pages.
    const all = getThread(fixture, { limit: 200 })
    expect(all.items.map((item) => item.id)).toEqual(['user:run-a', 'user:run-b', 'user:run-c'])
  })

  it('rejects an undecodable cursor with VALIDATION_FAILED', () => {
    const fixture = setup()
    const result = fixture.projection.getThread({ taskId: 'task-1', afterCursor: 'not-a-cursor' })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('reads through a readonly connection without any write (file database)', () => {
    const directory = mkdtempSync(join(tmpdir(), 'teskra-thread-db-'))
    const databaseFile = join(directory, 'teskra.db')
    const seed = setup({ databaseFile })
    createRun(seed, 'run-1', { prompt: 'Fix the login page' })
    appendObservation(seed, 'run-1', 1, 'Done.', T1)
    seed.connection.close()

    // A readonly connection rejects writes at the SQLite level, so a
    // successful projection proves the read model never writes.
    const readonly = new Database(databaseFile, { readonly: true })
    try {
      const projection = createThreadProjection({
        runs: createAgentRunRepository(readonly),
        workflowRuns: createWorkflowRunRepository(readonly),
        handoffs: createHandoffRepository(readonly),
        agentEvents: createAgentEventRepository(readonly),
        decisions: createDecisionRepository(readonly),
        paths: {
          runFiles: (runId: string): IpcResult<RunPaths> => ({
            ok: true,
            data: runPaths(join(directory, runId)),
          }),
        },
      })
      const thread = requireOk(projection.getThread({ taskId: 'task-1' }))
      expect(thread.items.map((item) => item.kind)).toEqual(['user_message', 'agent_reply'])
      expect(itemsOfKind(thread.items, 'agent_reply')[0]).toMatchObject({
        text: 'Done.',
        source: 'observation',
      })
    } finally {
      readonly.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
