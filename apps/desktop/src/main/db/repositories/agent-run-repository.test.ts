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

  it('round-trips queued_reason and clears it with null (TASK-120)', () => {
    setup()
    const created = repo.create({
      id: 'run-1',
      workspaceId: 'ws-1',
      agentType: 'codex',
      executionMode: 'orchestrated',
      runDir: 'runs/run-1',
      status: 'queued',
      queuedReason: 'capacity',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.queuedReason).toBe('capacity')
    expect(repo.getById('run-1')).toEqual(created)

    const updated = repo.update('run-1', { queuedReason: 'worktree_busy' })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.data?.queuedReason).toBe('worktree_busy')

    const cleared = repo.update('run-1', { status: 'preparing', queuedReason: null })
    expect(cleared.ok).toBe(true)
    if (!cleared.ok) return
    expect(cleared.data?.status).toBe('preparing')
    expect(cleared.data?.queuedReason).toBeUndefined()

    // Runs without a reason read back with the field absent.
    const plain = repo.create({
      id: 'run-2',
      workspaceId: 'ws-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: 'runs/run-2',
    })
    expect(plain.ok).toBe(true)
    if (!plain.ok) return
    expect(plain.data.queuedReason).toBeUndefined()
  })

  it('reads back the 013 profile identity columns (TASK-095)', () => {
    setup()
    repo.create({
      id: 'run-1',
      workspaceId: 'ws-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: 'runs/run-1',
    })
    connection
      .prepare(
        `UPDATE agent_runs
         SET account_profile_id = ?, execution_profile_id = ?, profile_snapshot_json = ?, failure_classification_json = ?
         WHERE id = ?`,
      )
      .run(
        'acct-1',
        'exec-1',
        JSON.stringify({ accountProfileId: 'acct-1', accountProfileName: 'Codex Personal' }),
        JSON.stringify({ kind: 'rate-limited', retryable: true }),
        'run-1',
      )

    const result = repo.getById('run-1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data?.accountProfileId).toBe('acct-1')
    expect(result.data?.executionProfileId).toBe('exec-1')
    expect(result.data?.profileSnapshot).toEqual({
      accountProfileId: 'acct-1',
      accountProfileName: 'Codex Personal',
    })
    expect(result.data?.failureClassification).toEqual({ kind: 'rate-limited', retryable: true })

    // Legacy rows (NULL columns) read back with the fields absent.
    repo.create({
      id: 'run-legacy',
      workspaceId: 'ws-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: 'runs/run-legacy',
    })
    const legacy = repo.getById('run-legacy')
    expect(legacy.ok).toBe(true)
    if (!legacy.ok) return
    expect(legacy.data?.accountProfileId).toBeUndefined()
    expect(legacy.data?.profileSnapshot).toBeUndefined()
    expect(legacy.data?.failureClassification).toBeUndefined()
  })

  it('returns VALIDATION_FAILED for corrupted profile_snapshot_json', () => {
    setup()
    repo.create({
      id: 'run-1',
      workspaceId: 'ws-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: 'runs/run-1',
    })
    connection
      .prepare('UPDATE agent_runs SET profile_snapshot_json = ? WHERE id = ?')
      .run('[broken', 'run-1')

    const result = repo.getById('run-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(result.error).not.toHaveProperty('detail')
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

  describe('listRateLimitStats (ADR-0010 aggregation)', () => {
    const NOW = '2026-09-12T00:00:00.000Z'

    function insertRun(
      id: string,
      options: {
        profileId?: string
        classification?: string | null
        finishedAt?: string
        updatedAt: string
      },
    ) {
      const created = repo.create(
        {
          id,
          workspaceId: 'ws-1',
          agentType: 'codex',
          executionMode: 'attended',
          runDir: `runs/${id}`,
          ...(options.profileId === undefined ? {} : { accountProfileId: options.profileId }),
        },
        options.updatedAt,
      )
      expect(created.ok).toBe(true)
      if (options.finishedAt !== undefined) {
        connection
          .prepare('UPDATE agent_runs SET finished_at = ? WHERE id = ?')
          .run(options.finishedAt, id)
      }
      if (options.classification !== undefined) {
        connection
          .prepare('UPDATE agent_runs SET failure_classification_json = ? WHERE id = ?')
          .run(options.classification, id)
      }
    }

    it('aggregates per profile, ignoring other kinds, NULL classifications, and runs outside the window', () => {
      setup()
      const rateLimited = JSON.stringify({ kind: 'rate-limited', retryable: true })
      const network = JSON.stringify({ kind: 'network', retryable: true })

      // acct-1: two rate-limited runs inside the window — the MAX timestamp
      // comes from the later one.
      insertRun('run-1', {
        profileId: 'acct-1',
        classification: rateLimited,
        finishedAt: '2026-09-08T10:00:00.000Z',
        updatedAt: '2026-09-08T10:00:00.000Z',
      })
      insertRun('run-2', {
        profileId: 'acct-1',
        classification: rateLimited,
        finishedAt: '2026-09-10T12:00:00.000Z',
        updatedAt: '2026-09-10T12:00:00.000Z',
      })
      // acct-1: rate-limited but older than the 7-day window — excluded.
      insertRun('run-3', {
        profileId: 'acct-1',
        classification: rateLimited,
        finishedAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      })
      // acct-1: inside the window but a different failure kind — excluded.
      insertRun('run-4', {
        profileId: 'acct-1',
        classification: network,
        finishedAt: '2026-09-11T00:00:00.000Z',
        updatedAt: '2026-09-11T00:00:00.000Z',
      })
      // acct-2: one hit; no finished_at — falls back to updated_at.
      insertRun('run-5', {
        profileId: 'acct-2',
        classification: rateLimited,
        updatedAt: '2026-09-09T08:00:00.000Z',
      })
      // acct-3: failed run with no classification at all — excluded.
      insertRun('run-6', {
        profileId: 'acct-3',
        classification: null,
        finishedAt: '2026-09-11T00:00:00.000Z',
        updatedAt: '2026-09-11T00:00:00.000Z',
      })
      // No profile (legacy run): never aggregated.
      insertRun('run-7', {
        classification: rateLimited,
        finishedAt: '2026-09-11T00:00:00.000Z',
        updatedAt: '2026-09-11T00:00:00.000Z',
      })

      const result = repo.listRateLimitStats(undefined, NOW)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data).toEqual([
        {
          profileId: 'acct-1',
          rateLimitedCount: 2,
          lastRateLimitedAt: '2026-09-10T12:00:00.000Z',
        },
        {
          profileId: 'acct-2',
          rateLimitedCount: 1,
          lastRateLimitedAt: '2026-09-09T08:00:00.000Z',
        },
      ])
    })

    it('honors an explicit window parameter', () => {
      setup()
      const rateLimited = JSON.stringify({ kind: 'rate-limited', retryable: true })
      insertRun('run-1', {
        profileId: 'acct-1',
        classification: rateLimited,
        finishedAt: '2026-09-05T00:00:00.000Z',
        updatedAt: '2026-09-05T00:00:00.000Z',
      })

      const wide = repo.listRateLimitStats(30 * 24 * 60 * 60 * 1000, NOW)
      expect(wide.ok && wide.data).toEqual([
        {
          profileId: 'acct-1',
          rateLimitedCount: 1,
          lastRateLimitedAt: '2026-09-05T00:00:00.000Z',
        },
      ])
      const narrow = repo.listRateLimitStats(24 * 60 * 60 * 1000, NOW)
      expect(narrow.ok && narrow.data).toEqual([])
    })
  })
})
