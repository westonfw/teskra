import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { runMigrations } from './migrate'
import { MIGRATIONS, migrateDatabase } from './migrations'

/**
 * TASK-120 acceptance for migration 017 (design doc §12.1, plan §139.1):
 * agent_runs gains queued_reason (CHECK-constrained to the four wait reasons,
 * nullable) and retry_of_run_id (self-FK, ON DELETE SET NULL, indexed). Both
 * are plain ADD COLUMNs, so pre-existing rows survive the upgrade as NULL.
 */

const AT = '2026-09-22T00:00:00.000Z'

const openConnections: Database.Database[] = []

function memoryDb(): Database.Database {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  openConnections.push(connection)
  return connection
}

function insertWorkspace(db: Database.Database, id = 'ws-1'): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
     VALUES (?, 'WS', 'windows', 'C:\\dev\\ws', ?, ?)`,
  ).run(id, AT, AT)
}

/** Inserts a run row; omit `queuedReason` entirely on pre-017 databases. */
function insertRun(db: Database.Database, id: string, queuedReason?: string): void {
  if (queuedReason === undefined) {
    db.prepare(
      `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
       VALUES (?, 'ws-1', 'codex', 'queued', 'orchestrated', ?, ?, ?)`,
    ).run(id, `runs/${id}`, AT, AT)
    return
  }
  db.prepare(
    `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, queued_reason, created_at, updated_at)
     VALUES (?, 'ws-1', 'codex', 'queued', 'orchestrated', ?, ?, ?, ?)`,
  ).run(id, `runs/${id}`, queuedReason, AT, AT)
}

afterEach(() => {
  for (const connection of openConnections.splice(0)) {
    connection.close()
  }
})

describe('migration 017 — agent run queue and retry (TASK-120/121)', () => {
  it('registers version 17 immediately after 016', () => {
    const index = MIGRATIONS.findIndex((migration) => migration.version === 17)
    expect(index).toBeGreaterThan(-1)
    expect(MIGRATIONS[index]?.name).toBe('017_agent_run_queue_and_retry')
    expect(MIGRATIONS[index - 1]?.version).toBe(16)
  })

  it('upgrades a populated v16 database; existing runs gain NULL columns', () => {
    const db = memoryDb()
    const partial = runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 16),
    )
    expect(partial.ok).toBe(true)
    if (!partial.ok) return
    expect(partial.data.toVersion).toBe(16)
    insertWorkspace(db)
    insertRun(db, 'run-legacy')

    const upgraded = migrateDatabase(db)
    expect(upgraded.ok).toBe(true)
    if (!upgraded.ok) return
    expect(upgraded.data.fromVersion).toBe(16)
    expect(upgraded.data.toVersion).toBe(17)

    const row = db
      .prepare('SELECT queued_reason, retry_of_run_id FROM agent_runs WHERE id = ?')
      .get('run-legacy') as { queued_reason: string | null; retry_of_run_id: string | null }
    expect(row).toEqual({ queued_reason: null, retry_of_run_id: null })
  })

  it.each(['capacity', 'directory_busy', 'worktree_busy', 'fifo'])(
    'accepts the queued_reason value %s',
    (reason) => {
      const db = memoryDb()
      expect(migrateDatabase(db).ok).toBe(true)
      insertWorkspace(db)
      insertRun(db, `run-${reason}`, reason)
      const row = db
        .prepare('SELECT queued_reason FROM agent_runs WHERE id = ?')
        .get(`run-${reason}`) as { queued_reason: string }
      expect(row.queued_reason).toBe(reason)
    },
  )

  it('rejects an unknown queued_reason via the CHECK constraint', () => {
    const db = memoryDb()
    expect(migrateDatabase(db).ok).toBe(true)
    insertWorkspace(db)
    expect(() => insertRun(db, 'run-bad', 'sleeping')).toThrow(/CHECK/u)
  })

  it('sets retry_of_run_id to NULL when the source run is deleted', () => {
    const db = memoryDb()
    expect(migrateDatabase(db).ok).toBe(true)
    insertWorkspace(db)
    insertRun(db, 'run-source')
    db.prepare(
      `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, retry_of_run_id, created_at, updated_at)
       VALUES ('run-retry', 'ws-1', 'codex', 'queued', 'orchestrated', 'runs/run-retry', 'run-source', ?, ?)`,
    ).run(AT, AT)

    db.prepare('DELETE FROM agent_runs WHERE id = ?').run('run-source')
    const row = db
      .prepare('SELECT retry_of_run_id FROM agent_runs WHERE id = ?')
      .get('run-retry') as { retry_of_run_id: string | null }
    expect(row.retry_of_run_id).toBeNull()
  })

  it('creates the idx_agent_runs_retry_of index', () => {
    const db = memoryDb()
    expect(migrateDatabase(db).ok).toBe(true)
    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_agent_runs_retry_of')
    expect(index).toBeDefined()
  })

  it('is re-runnable: migrating an up-to-date database is a no-op', () => {
    const db = memoryDb()
    expect(migrateDatabase(db).ok).toBe(true)
    const again = migrateDatabase(db)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.data.applied).toEqual([])
    expect(again.data.toVersion).toBe(17)
  })
})
