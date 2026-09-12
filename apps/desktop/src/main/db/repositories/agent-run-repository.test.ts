import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import { ISO_UTC_PATTERN } from './common'
import { createAgentRunRepository, type AgentRunRepository } from './agent-run-repository'

let connection: Database.Database
let repo: AgentRunRepository

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
       VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at)
       VALUES ('task-1', 'ws-1', 'T', 'ready', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
    )
    .run()
  repo = createAgentRunRepository(connection)
}

afterEach(() => {
  connection.close()
})

describe('AgentRunRepository', () => {
  it('creates a run with defaults and reads it back', () => {
    setup()
    const created = repo.create({
      id: 'run-1',
      workspaceId: 'ws-1',
      taskId: 'task-1',
      agentType: 'codex',
      role: 'implementer',
      approvalMode: 'safe-auto',
      executionMode: 'orchestrated',
      runDir: 'runs/run-1',
      prompt: 'Do it',
      providerSession: { sessionId: 'abc' },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.status).toBe('created')
    expect(created.data.providerSession).toEqual({ sessionId: 'abc' })
    expect(created.data.createdAt).toMatch(ISO_UTC_PATTERN)
    expect(repo.getById('run-1')).toEqual(created)
  })

  it('round-trips the persisted launch mode (ADR-0007), absent for legacy rows', () => {
    setup()
    const created = repo.create({
      id: 'run-exec',
      workspaceId: 'ws-1',
      agentType: 'codex',
      executionMode: 'orchestrated',
      runDir: 'runs/run-exec',
      mode: 'exec',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.mode).toBe('exec')
    expect(repo.getById('run-exec')).toEqual(created)

    const legacy = repo.create({
      id: 'run-legacy',
      workspaceId: 'ws-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: 'runs/run-legacy',
    })
    expect(legacy.ok).toBe(true)
    if (!legacy.ok) return
    // Rows without a recorded mode read back as undefined (pre-009 behavior).
    expect(legacy.data.mode).toBeUndefined()
  })

  it('updates lifecycle fields including error_json roundtrip', () => {
    setup()
    repo.create({
      id: 'run-1',
      workspaceId: 'ws-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: 'runs/run-1',
    })
    const updated = repo.update('run-1', {
      status: 'failed',
      exitCode: 1,
      finishedAt: '2026-09-09T12:00:00.000Z',
      error: { code: 'UNKNOWN', message: 'boom' },
    })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.data?.status).toBe('failed')
    expect(updated.data?.exitCode).toBe(1)
    expect(updated.data?.error).toEqual({ code: 'UNKNOWN', message: 'boom' })
  })

  it('listActive only returns running/preparing/queued', () => {
    setup()
    const statuses = ['created', 'queued', 'running', 'completed', 'interrupted'] as const
    statuses.forEach((status, index) => {
      const result = repo.create({
        id: `run-${index}`,
        workspaceId: 'ws-1',
        agentType: 'codex',
        executionMode: 'attended',
        runDir: `runs/run-${index}`,
        status,
      })
      expect(result.ok).toBe(true)
    })
    const active = repo.listActive()
    expect(active.ok).toBe(true)
    if (!active.ok) return
    expect(active.data.map((run) => run.status).sort()).toEqual(['queued', 'running'])
  })

  it('lists by task / workspace / workflow run', () => {
    setup()
    repo.create({
      id: 'run-1',
      workspaceId: 'ws-1',
      taskId: 'task-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: 'runs/run-1',
    })
    expect(repo.listByTask('task-1')).toMatchObject({ ok: true })
    expect(repo.listByWorkspace('ws-1')).toMatchObject({ ok: true })
    expect(repo.listByWorkflowRun('none')).toEqual({ ok: true, data: [] })
    const byTask = repo.listByTask('task-1')
    expect(byTask.ok && byTask.data.length).toBe(1)
  })

  it('returns VALIDATION_FAILED for corrupted provider_session_json', () => {
    setup()
    repo.create({
      id: 'run-1',
      workspaceId: 'ws-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: 'runs/run-1',
    })
    connection
      .prepare('UPDATE agent_runs SET provider_session_json = ? WHERE id = ?')
      .run('[broken', 'run-1')

    const result = repo.getById('run-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(result.error).not.toHaveProperty('detail')
  })

  it('returns VALIDATION_FAILED for a status outside AgentRunStatus', () => {
    setup()
    repo.create({
      id: 'run-1',
      workspaceId: 'ws-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: 'runs/run-1',
    })
    connection.prepare('UPDATE agent_runs SET status = ? WHERE id = ?').run('zombie', 'run-1')

    const result = repo.listByWorkspace('ws-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('deletes a run', () => {
    setup()
    repo.create({
      id: 'run-1',
      workspaceId: 'ws-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: 'runs/run-1',
    })
    expect(repo.delete('run-1')).toEqual({ ok: true, data: true })
  })
})
