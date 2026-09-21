import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { runMigrations } from './migrate'
import { MIGRATIONS, migrateDatabase } from './migrations'

/**
 * TASK-128 acceptance for migration 019 (design doc §12.3, plan §139.1,
 * ADR-0014): the `pending_decisions` inbox. Column-level DDL equivalence with
 * plan §139.1 is asserted in schema.test.ts; this file proves the constraint
 * BEHAVIOR — every CHECK / the partial unique index / the SET NULL FKs gets a
 * "make it fail" test, plus the workspace cascade.
 */

const AT = '2026-09-22T00:00:00.000Z'

const openConnections: Database.Database[] = []

function memoryDb(): Database.Database {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  openConnections.push(connection)
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
  return connection
}

function insertWorkspace(db: Database.Database, id = 'ws-1'): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
     VALUES (?, 'WS', 'windows', 'C:\\dev\\ws', ?, ?)`,
  ).run(id, AT, AT)
}

interface DecisionRowOptions {
  readonly id: string
  readonly kind?: string
  readonly status?: string
  readonly severity?: string
  readonly dedupeKey?: string
  readonly runId?: string
  readonly workspaceId?: string
}

function insertDecision(db: Database.Database, options: DecisionRowOptions): void {
  db.prepare(
    `INSERT INTO pending_decisions (id, workspace_id, kind, status, severity, run_id, dedupe_key, title, detail_json, options_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'T', '{}', '[]', ?)`,
  ).run(
    options.id,
    options.workspaceId ?? 'ws-1',
    options.kind ?? 'shell_confirmation',
    options.status ?? 'open',
    options.severity ?? 'blocking',
    options.runId ?? null,
    options.dedupeKey ?? `key:${options.id}`,
    AT,
  )
}

function insertRun(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
     VALUES (?, 'ws-1', 'codex', 'running', 'orchestrated', ?, ?, ?)`,
  ).run(id, `runs/${id}`, AT, AT)
}

afterEach(() => {
  for (const connection of openConnections.splice(0)) {
    connection.close()
  }
})

describe('migration 019 — pending_decisions (TASK-128)', () => {
  it('registers version 19 immediately after 017; 018 is reserved for TASK-124', () => {
    const index = MIGRATIONS.findIndex((migration) => migration.version === 19)
    expect(index).toBeGreaterThan(-1)
    expect(MIGRATIONS[index]?.name).toBe('019_pending_decisions')
    expect(MIGRATIONS[index - 1]?.version).toBe(17)
    expect(MIGRATIONS.some((migration) => migration.version === 18)).toBe(false)
  })

  it.each([
    'shell_confirmation',
    'agent_blocker',
    'stalled_run',
    'merge_blocked',
    'rate_limit',
    'handoff_degraded',
  ])('accepts the kind value %s', (kind) => {
    const db = memoryDb()
    insertWorkspace(db)
    insertDecision(db, { id: `dec-${kind}`, kind })
    expect(
      db.prepare('SELECT kind FROM pending_decisions WHERE id = ?').get(`dec-${kind}`),
    ).toEqual({ kind })
  })

  it('rejects an unknown kind via the CHECK constraint', () => {
    const db = memoryDb()
    insertWorkspace(db)
    expect(() => insertDecision(db, { id: 'dec-bad', kind: 'always_allow' })).toThrow(/CHECK/u)
  })

  it.each(['open', 'resolved', 'expired', 'cancelled'])('accepts the status value %s', (status) => {
    const db = memoryDb()
    insertWorkspace(db)
    insertDecision(db, { id: `dec-${status}`, status })
    expect(
      db.prepare('SELECT status FROM pending_decisions WHERE id = ?').get(`dec-${status}`),
    ).toEqual({ status })
  })

  it('rejects an unknown status via the CHECK constraint', () => {
    const db = memoryDb()
    insertWorkspace(db)
    expect(() => insertDecision(db, { id: 'dec-bad', status: 'pending' })).toThrow(/CHECK/u)
  })

  it.each(['info', 'warning', 'blocking'])('accepts the severity value %s', (severity) => {
    const db = memoryDb()
    insertWorkspace(db)
    insertDecision(db, { id: `dec-${severity}`, severity })
    expect(
      db.prepare('SELECT severity FROM pending_decisions WHERE id = ?').get(`dec-${severity}`),
    ).toEqual({ severity })
  })

  it('rejects an unknown severity via the CHECK constraint', () => {
    const db = memoryDb()
    insertWorkspace(db)
    expect(() => insertDecision(db, { id: 'dec-bad', severity: 'fatal' })).toThrow(/CHECK/u)
  })

  it('partial unique index: a second OPEN row with the same dedupe_key fails', () => {
    const db = memoryDb()
    insertWorkspace(db)
    insertDecision(db, { id: 'dec-1', dedupeKey: 'shell_confirmation:step-1' })
    expect(() =>
      insertDecision(db, { id: 'dec-2', dedupeKey: 'shell_confirmation:step-1' }),
    ).toThrow(/UNIQUE/u)
  })

  it('partial unique index: the key frees up once the open row is closed', () => {
    const db = memoryDb()
    insertWorkspace(db)
    insertDecision(db, { id: 'dec-1', dedupeKey: 'shell_confirmation:step-1' })
    insertDecision(db, { id: 'dec-2', dedupeKey: 'shell_confirmation:step-1', status: 'resolved' })
    // A closed row no longer holds the key: a new open row with it is legal.
    db.prepare("UPDATE pending_decisions SET status = 'resolved' WHERE id = 'dec-1'").run()
    insertDecision(db, { id: 'dec-3', dedupeKey: 'shell_confirmation:step-1' })
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM pending_decisions WHERE dedupe_key = ? AND status = 'open'",
        )
        .get('shell_confirmation:step-1'),
    ).toEqual({ n: 1 })
  })

  it('sets run_id to NULL when the source agent_run is deleted (ADR-0014 §6)', () => {
    const db = memoryDb()
    insertWorkspace(db)
    insertRun(db, 'run-1')
    insertDecision(db, { id: 'dec-1', runId: 'run-1' })

    db.prepare('DELETE FROM agent_runs WHERE id = ?').run('run-1')
    // The decision row survives the source Run — it is part of the audit trail.
    expect(db.prepare('SELECT run_id FROM pending_decisions WHERE id = ?').get('dec-1')).toEqual({
      run_id: null,
    })
  })

  it('deleting the workspace cascades to its pending decisions', () => {
    const db = memoryDb()
    insertWorkspace(db)
    insertDecision(db, { id: 'dec-1' })

    db.prepare('DELETE FROM workspaces WHERE id = ?').run('ws-1')
    expect(db.prepare('SELECT COUNT(*) AS n FROM pending_decisions').get()).toEqual({ n: 0 })
  })

  it('creates the three §139.1 indexes', () => {
    const db = memoryDb()
    for (const name of [
      'idx_pending_decisions_open_dedupe',
      'idx_pending_decisions_workspace_open',
      'idx_pending_decisions_run',
    ]) {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name),
      ).toBeDefined()
    }
  })

  it('is re-runnable: migrating an up-to-date database is a no-op', () => {
    const db = memoryDb()
    const again = migrateDatabase(db)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.data.applied).toEqual([])
    expect(again.data.toVersion).toBe(19)
  })

  it('upgrades a populated v17 database', () => {
    const db = new Database(':memory:')
    openConnections.push(db)
    db.pragma('foreign_keys = ON')
    const partial = runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 17),
    )
    expect(partial.ok).toBe(true)
    if (!partial.ok) return
    expect(partial.data.toVersion).toBe(17)
    insertWorkspace(db)
    insertRun(db, 'run-legacy')

    const upgraded = migrateDatabase(db)
    expect(upgraded.ok).toBe(true)
    if (!upgraded.ok) return
    expect(upgraded.data).toEqual({ fromVersion: 17, toVersion: 19, applied: [19] })
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get()).toEqual({ n: 1 })
  })
})
