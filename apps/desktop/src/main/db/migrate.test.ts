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
})

describe('MIGRATIONS registry (TASK-006)', () => {
  it('is the ordered 001–006 chain', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6])
    expect(MIGRATIONS.map((m) => m.name)).toEqual([
      '001_init',
      '002_runs',
      '003_criteria_review',
      '004_artifacts_memory',
      '005_permissions',
      '006_worktree_archive',
    ])
  })

  it('migrates an empty database to the latest version via migrateDatabase', () => {
    const db = memoryDb()
    const result = migrateDatabase(db)
    expect(result).toEqual({
      ok: true,
      data: { fromVersion: 0, toVersion: 6, applied: [1, 2, 3, 4, 5, 6] },
    })
    expect(appliedVersions(db)).toEqual([1, 2, 3, 4, 5, 6])

    const second = migrateDatabase(db)
    expect(second).toEqual({ ok: true, data: { fromVersion: 6, toVersion: 6, applied: [] } })
  })
})
