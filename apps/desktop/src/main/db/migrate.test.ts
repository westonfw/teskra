import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { runMigrations, type Migration } from './migrate'
import { MIGRATIONS, migrateDatabase } from './migrations'

// Fixture migrations are defined inline so tests never touch the canonical
// 001–005 files (whose DDL belongs to TASK-090).
function fixture(version: number, sql: string, name?: string): Migration {
  return { version, name: name ?? `fixture_${version}`, sql }
}

const openConnections: Database.Database[] = []

function memoryDb(): Database.Database {
  const connection = new Database(':memory:')
  openConnections.push(connection)
  return connection
}

afterEach(() => {
  for (const connection of openConnections.splice(0)) {
    connection.close()
  }
})

function appliedVersions(connection: Database.Database): number[] {
  const rows = connection
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as { version: number }[]
  return rows.map((row) => row.version)
}

function tableExists(connection: Database.Database, table: string): boolean {
  const row = connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  return row !== undefined
}

describe('runMigrations (TASK-006)', () => {
  it('upgrades an empty database to the latest version', () => {
    const db = memoryDb()
    const result = runMigrations(db, [
      fixture(1, 'CREATE TABLE one (id INTEGER PRIMARY KEY)'),
      fixture(2, 'CREATE TABLE two (id INTEGER PRIMARY KEY)'),
      fixture(3, 'CREATE TABLE three (id INTEGER PRIMARY KEY)'),
    ])

    expect(result).toEqual({ ok: true, data: { fromVersion: 0, toVersion: 3, applied: [1, 2, 3] } })
    expect(tableExists(db, 'one')).toBe(true)
    expect(tableExists(db, 'two')).toBe(true)
    expect(tableExists(db, 'three')).toBe(true)
    expect(appliedVersions(db)).toEqual([1, 2, 3])
  })

  it('does not re-execute already-applied migrations', () => {
    const db = memoryDb()
    // CREATE TABLE without IF NOT EXISTS would throw on a second run, so a
    // green second call proves version gating, not luck.
    const migrations = [
      fixture(1, 'CREATE TABLE one (id INTEGER PRIMARY KEY)'),
      fixture(2, 'CREATE TABLE two (id INTEGER PRIMARY KEY)'),
    ]
    expect(runMigrations(db, migrations)).toEqual({
      ok: true,
      data: { fromVersion: 0, toVersion: 2, applied: [1, 2] },
    })

    const second = runMigrations(db, migrations)
    expect(second).toEqual({ ok: true, data: { fromVersion: 2, toVersion: 2, applied: [] } })
    expect(appliedVersions(db)).toEqual([1, 2])
  })

  it('applies only the pending tail when upgrading an existing database', () => {
    const db = memoryDb()
    expect(runMigrations(db, [fixture(1, 'CREATE TABLE one (id INTEGER PRIMARY KEY)')]).ok).toBe(
      true,
    )

    const upgrade = runMigrations(db, [
      fixture(1, 'CREATE TABLE one (id INTEGER PRIMARY KEY)'),
      fixture(2, 'CREATE TABLE two (id INTEGER PRIMARY KEY)'),
    ])
    expect(upgrade).toEqual({ ok: true, data: { fromVersion: 1, toVersion: 2, applied: [2] } })
    expect(appliedVersions(db)).toEqual([1, 2])
  })

  it('rolls back a failed migration in its own transaction and stops the chain', () => {
    const db = memoryDb()
    const result = runMigrations(db, [
      fixture(1, 'CREATE TABLE one (id INTEGER PRIMARY KEY)'),
      // The first statement would succeed; the second must roll both back.
      fixture(2, 'CREATE TABLE two (id INTEGER PRIMARY KEY); SELECT * FROM no_such_table'),
      fixture(3, 'CREATE TABLE three (id INTEGER PRIMARY KEY)'),
    ])

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('UNKNOWN')
      expect(result.error.message).toContain('rolled back')
      // The public shape never carries detail / cause (TASK-003).
      expect(result.error).not.toHaveProperty('detail')
      expect(result.error).not.toHaveProperty('cause')
    }
    expect(tableExists(db, 'one')).toBe(true)
    // Version 2 fully rolled back: neither its table nor its version row.
    expect(tableExists(db, 'two')).toBe(false)
    expect(tableExists(db, 'three')).toBe(false)
    expect(appliedVersions(db)).toEqual([1])
  })

  it('fails loudly when the database is newer than the code', () => {
    const db = memoryDb()
    const upToThree = [
      fixture(1, 'CREATE TABLE one (id INTEGER PRIMARY KEY)'),
      fixture(2, 'CREATE TABLE two (id INTEGER PRIMARY KEY)'),
      fixture(3, 'CREATE TABLE three (id INTEGER PRIMARY KEY)'),
    ]
    expect(runMigrations(db, upToThree).ok).toBe(true)

    const result = runMigrations(db, upToThree.slice(0, 1))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_FAILED')
      expect(result.error.message).toContain('newer')
      expect(result.error.retryable).toBe(false)
    }
  })

  it('rejects duplicate or invalid migration versions', () => {
    const db = memoryDb()
    const duplicate = runMigrations(db, [
      fixture(1, 'CREATE TABLE one (id INTEGER PRIMARY KEY)'),
      fixture(1, 'CREATE TABLE uno (id INTEGER PRIMARY KEY)', 'duplicate'),
    ])
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) {
      expect(duplicate.error.code).toBe('VALIDATION_FAILED')
    }

    const invalid = runMigrations(db, [fixture(0, 'CREATE TABLE zero (id INTEGER PRIMARY KEY)')])
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) {
      expect(invalid.error.code).toBe('VALIDATION_FAILED')
    }
    expect(tableExists(db, 'schema_migrations')).toBe(false)
  })

  it('supports foreignKeysOff table-rebuild migrations without cascading data loss (TASK-056)', () => {
    const db = memoryDb()
    db.pragma('foreign_keys = ON')
    const result = runMigrations(db, [
      fixture(
        1,
        `CREATE TABLE parent (id TEXT PRIMARY KEY, keep TEXT NOT NULL);
         CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
         INSERT INTO parent VALUES ('p1', 'v1');
         INSERT INTO child VALUES ('c1', 'p1');`,
      ),
      {
        ...fixture(
          2,
          `CREATE TABLE parent_new (id TEXT PRIMARY KEY, keep TEXT);
           INSERT INTO parent_new SELECT id, keep FROM parent;
           DROP TABLE parent;
           ALTER TABLE parent_new RENAME TO parent;`,
          'rebuild_parent',
        ),
        foreignKeysOff: true,
      },
    ])
    expect(result.ok).toBe(true)
    // With FK on, DROP TABLE parent would implicit-DELETE 'p1' and CASCADE
    // into child; with FK off the rebuild preserves both rows.
    expect(db.prepare('SELECT keep FROM parent WHERE id = ?').get('p1')).toEqual({ keep: 'v1' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM child').get()).toEqual({ n: 1 })
    // FK enforcement is restored afterwards.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(() => db.prepare("INSERT INTO child VALUES ('c2', 'ghost')").run()).toThrow(
      /FOREIGN KEY/,
    )
  })

  it('rolls back a foreignKeysOff migration whose rebuild violates FK (in-transaction check)', () => {
    const db = memoryDb()
    db.pragma('foreign_keys = ON')
    const result = runMigrations(db, [
      fixture(
        1,
        `CREATE TABLE parent (id TEXT PRIMARY KEY);
         CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
         INSERT INTO parent VALUES ('p1');
         INSERT INTO child VALUES ('c1', 'p1');`,
      ),
      {
        // Rebuilds parent WITHOUT copying 'p1' → orphan child row.
        ...fixture(
          2,
          `CREATE TABLE parent_new (id TEXT PRIMARY KEY);
           DROP TABLE parent;
           ALTER TABLE parent_new RENAME TO parent;`,
          'rebuild_parent_lossy',
        ),
        foreignKeysOff: true,
      },
    ])
    expect(result.ok).toBe(false)
    expect(appliedVersions(db)).toEqual([1])
    expect(db.prepare('SELECT COUNT(*) AS n FROM parent').get()).toEqual({ n: 1 })
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })
})

describe('MIGRATIONS registry (TASK-006)', () => {
  it('is the ordered 001–011 chain', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(MIGRATIONS.map((m) => m.name)).toEqual([
      '001_init',
      '002_runs',
      '003_criteria_review',
      '004_artifacts_memory',
      '005_permissions',
      '006_worktree_archive',
      '007_workflow_run_task_optional',
      '008_workflow_run_criteria_iteration',
      '009_agent_run_mode',
      '010_criteria_set_task_nullable',
      '011_agent_run_pid_identity',
    ])
  })

  it('migrates an empty database to the latest version via migrateDatabase', () => {
    const db = memoryDb()
    const result = migrateDatabase(db)
    expect(result).toEqual({
      ok: true,
      data: { fromVersion: 0, toVersion: 11, applied: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
    })
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])

    const second = migrateDatabase(db)
    expect(second).toEqual({ ok: true, data: { fromVersion: 11, toVersion: 11, applied: [] } })
  })

  it('007/008 upgrade a populated v6 database without losing workflow runs or steps (TASK-056/062)', () => {
    const db = memoryDb()
    db.pragma('foreign_keys = ON')
    const first = runMigrations(db, MIGRATIONS.slice(0, 6))
    expect(first.ok).toBe(true)

    const AT = '2026-09-09T00:00:00.000Z'
    db.prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws1', 'ws', 'wsl', '/repo', ?, ?)`,
    ).run(AT, AT)
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at)
       VALUES ('t1', 'ws1', 'task', 'ready', ?, ?)`,
    ).run(AT, AT)
    db.prepare(
      `INSERT INTO workflow_runs (id, task_id, workflow_definition_id, definition_json, status, created_at)
       VALUES ('wr1', 't1', 'def', '{}', 'running', ?)`,
    ).run(AT)
    db.prepare(
      `INSERT INTO workflow_steps (id, workflow_run_id, node_id, node_type, status, created_at)
       VALUES ('st1', 'wr1', 'n1', 'agent', 'running', ?)`,
    ).run(AT)

    const upgraded = migrateDatabase(db)
    expect(upgraded).toEqual({
      ok: true,
      data: { fromVersion: 6, toVersion: 11, applied: [7, 8, 9, 10, 11] },
    })

    // Rows survived the table rebuild (DROP TABLE would have cascaded with FK on).
    expect(db.prepare('SELECT COUNT(*) AS n FROM workflow_runs').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM workflow_steps').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT task_id FROM workflow_runs WHERE id = ?').get('wr1')).toEqual({
      task_id: 't1',
    })
    // 008 (TASK-062): pre-existing rows gain the per-criteria-version counter at 0.
    expect(
      db.prepare('SELECT criteria_iteration FROM workflow_runs WHERE id = ?').get('wr1'),
    ).toEqual({ criteria_iteration: 0 })
    // task_id is nullable now; FK enforcement is back on.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_runs (id, task_id, workflow_definition_id, definition_json, status, created_at)
           VALUES ('wr-ghost', 'ghost-task', 'def', '{}', 'created', ?)`,
        )
        .run(AT),
    ).toThrow(/FOREIGN KEY/)
  })
})
