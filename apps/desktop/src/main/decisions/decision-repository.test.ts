import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../db/migrations'
import { createDecisionRepository, type DecisionRepository } from './decision-repository'

const AT = '2026-09-22T00:00:00.000Z'
const LATER = '2026-09-22T00:10:00.000Z'

let connection: Database.Database
let repo: DecisionRepository

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
       VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', '${AT}', '${AT}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
       VALUES ('run-1', 'ws-1', 'codex', 'running', 'orchestrated', 'runs/run-1', '${AT}', '${AT}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO workflow_runs (id, task_id, workflow_definition_id, definition_json, status, created_at)
       VALUES ('wfr-1', NULL, 'def', '{}', 'running', '${AT}')`,
    )
    .run()
  repo = createDecisionRepository(connection)
}

afterEach(() => {
  connection.close()
})

function insertInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dec-1',
    workspaceId: 'ws-1',
    kind: 'shell_confirmation' as const,
    severity: 'blocking' as const,
    dedupeKey: 'shell_confirmation:step-1',
    title: 'Confirm shell step',
    detail: { kind: 'shell_confirmation' as const, command: 'npm run build', cwd: '/repo' },
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject', danger: true },
    ],
    ...overrides,
  }
}

describe('DecisionRepository (TASK-128)', () => {
  it('inserts an open decision and reads it back with decoded JSON columns', () => {
    setup()
    const created = repo.insert(
      insertInput({
        runId: 'run-1',
        workflowRunId: 'wfr-1',
        expiresAt: LATER,
      }),
      AT,
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.status).toBe('open')
    expect(created.data.detail).toEqual({
      kind: 'shell_confirmation',
      command: 'npm run build',
      cwd: '/repo',
    })
    expect(created.data.options).toHaveLength(2)
    expect(created.data.runId).toBe('run-1')
    expect(created.data.workflowRunId).toBe('wfr-1')
    expect(created.data.expiresAt).toBe(LATER)
    expect(created.data.resolution).toBeUndefined()
    expect(created.data.createdAt).toBe(AT)
    expect(repo.getById('dec-1')).toEqual(created)
  })

  it('maps a duplicate open dedupeKey insert to CONFLICT (partial unique index)', () => {
    setup()
    expect(repo.insert(insertInput(), AT).ok).toBe(true)
    const duplicate = repo.insert(insertInput({ id: 'dec-2' }), AT)
    expect(duplicate.ok).toBe(false)
    if (duplicate.ok) return
    expect(duplicate.error.code).toBe('CONFLICT')
    // The error is the public shape only — no detail / cause leak.
    expect(duplicate.error).not.toHaveProperty('detail')
  })

  it('getOpenByDedupeKey returns only the open row for the key', () => {
    setup()
    expect(repo.getOpenByDedupeKey('shell_confirmation:step-1')).toEqual({ ok: true, data: null })
    repo.insert(insertInput(), AT)
    const open = repo.getOpenByDedupeKey('shell_confirmation:step-1')
    expect(open.ok).toBe(true)
    if (!open.ok) return
    expect(open.data?.id).toBe('dec-1')
  })

  it('lists with workspaceId / kind / status filters combined', () => {
    setup()
    repo.insert(insertInput(), AT)
    repo.insert(
      insertInput({
        id: 'dec-2',
        kind: 'stalled_run',
        severity: 'warning',
        dedupeKey: 'stalled_run:run-1',
        detail: { kind: 'stalled_run', silentForMs: 60_000 },
        options: [{ id: 'keep_waiting', label: 'Keep waiting' }],
      }),
      AT,
    )
    repo.closeOpen('dec-2', { status: 'resolved', resolution: undefined }, AT)

    const openShell = repo.list({ workspaceId: 'ws-1', kind: 'shell_confirmation', status: 'open' })
    expect(openShell.ok).toBe(true)
    if (!openShell.ok) return
    expect(openShell.data.map((decision) => decision.id)).toEqual(['dec-1'])

    const resolved = repo.list({ status: 'resolved' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.data.map((decision) => decision.id)).toEqual(['dec-2'])

    const missingWorkspace = repo.list({ workspaceId: 'ws-2' })
    expect(missingWorkspace).toEqual({ ok: true, data: [] })
  })

  it('listExpirable returns only due open rows; NULL expires_at never expires', () => {
    setup()
    repo.insert(insertInput({ expiresAt: AT }), AT) // due at LATER
    repo.insert(
      insertInput({ id: 'dec-2', dedupeKey: 'k:2', expiresAt: '2026-09-22T01:00:00.000Z' }),
      AT,
    ) // not yet due
    repo.insert(insertInput({ id: 'dec-3', dedupeKey: 'k:3' }), AT) // never expires

    const due = repo.listExpirable(LATER)
    expect(due.ok).toBe(true)
    if (!due.ok) return
    expect(due.data.map((decision) => decision.id)).toEqual(['dec-1'])
  })

  it('listOpenByKind / listOpenBySource select open rows only', () => {
    setup()
    repo.insert(insertInput({ runId: 'run-1', workflowRunId: 'wfr-1' }), AT)
    repo.insert(insertInput({ id: 'dec-2', dedupeKey: 'k:2' }), AT)
    repo.closeOpen('dec-2', { status: 'cancelled' }, AT)

    const byKind = repo.listOpenByKind('shell_confirmation')
    expect(byKind.ok && byKind.data.map((decision) => decision.id)).toEqual(['dec-1'])

    const byRun = repo.listOpenBySource({ runId: 'run-1' })
    expect(byRun.ok && byRun.data.map((decision) => decision.id)).toEqual(['dec-1'])
    const byWorkflowRun = repo.listOpenBySource({ workflowRunId: 'wfr-1' })
    expect(byWorkflowRun.ok && byWorkflowRun.data.map((decision) => decision.id)).toEqual(['dec-1'])
    const byOther = repo.listOpenBySource({ runId: 'run-2' })
    expect(byOther).toEqual({ ok: true, data: [] })
    expect(repo.listOpenBySource({})).toEqual({ ok: true, data: [] })
  })

  it('closeOpen is a CAS: only the first close succeeds', () => {
    setup()
    repo.insert(insertInput(), AT)
    const resolution = { optionId: 'approve', decidedBy: 'user' as const, decidedAt: AT }
    const first = repo.closeOpen('dec-1', { status: 'resolved', resolution }, AT)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.data?.status).toBe('resolved')
    expect(first.data?.resolution).toEqual(resolution)
    expect(first.data?.resolvedAt).toBe(AT)

    // Second close — any target status — loses the CAS.
    expect(repo.closeOpen('dec-1', { status: 'expired', resolution }, AT)).toEqual({
      ok: true,
      data: null,
    })
    expect(repo.closeOpen('dec-1', { status: 'cancelled' }, AT)).toEqual({ ok: true, data: null })
    // Unknown id is also a CAS miss.
    expect(repo.closeOpen('dec-missing', { status: 'resolved', resolution }, AT)).toEqual({
      ok: true,
      data: null,
    })
  })

  it('cancelled rows keep resolution_json NULL', () => {
    setup()
    repo.insert(insertInput(), AT)
    const cancelled = repo.closeOpen('dec-1', { status: 'cancelled' }, AT)
    expect(cancelled.ok).toBe(true)
    if (!cancelled.ok) return
    expect(cancelled.data?.status).toBe('cancelled')
    expect(cancelled.data?.resolution).toBeUndefined()
    expect(cancelled.data?.resolvedAt).toBe(AT)
  })

  it('corrupted detail_json surfaces as VALIDATION_FAILED, not a throw', () => {
    setup()
    repo.insert(insertInput(), AT)
    connection
      .prepare("UPDATE pending_decisions SET detail_json = 'not-json' WHERE id = 'dec-1'")
      .run()
    const read = repo.getById('dec-1')
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error.code).toBe('VALIDATION_FAILED')
  })
})
