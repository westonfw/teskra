import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { runMigrations } from './migrate'
import { MIGRATIONS, migrateDatabase } from './migrations'

/**
 * TASK-118 acceptance for migration 015 (design doc §43, code-review P0-3):
 * workspaces gain a trust_level column whose safe default ('restricted') also
 * applies to pre-existing rows on upgrade, the CHECK constraint rejects
 * unknown levels, and the migration registers after 014 (TASK-110) so
 * `MAX(version)`-based skipping cannot strand 012–014.
 */

const AT = '2026-09-15T00:00:00.000Z'

const openConnections: Database.Database[] = []

function memoryDb(): Database.Database {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  openConnections.push(connection)
  return connection
}

afterEach(() => {
  for (const connection of openConnections.splice(0)) {
    connection.close()
  }
})

describe('migration 015 — workspace trust (TASK-118)', () => {
  it('registers version 15 immediately after 014', () => {
    const index = MIGRATIONS.findIndex((migration) => migration.version === 15)
    expect(index).toBeGreaterThan(-1)
    expect(MIGRATIONS[index]?.name).toBe('015_workspace_trust')
    expect(MIGRATIONS[index - 1]?.version).toBe(14)
  })

  it('adds trust_level with a restricted default on a fresh database', () => {
    const db = memoryDb()
    const migrated = migrateDatabase(db)
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    expect(migrated.data.toVersion).toBe(16)

    db.prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', ?, ?)`,
    ).run(AT, AT)
    const row = db.prepare('SELECT trust_level FROM workspaces WHERE id = ?').get('ws-1') as {
      trust_level: string
    }
    expect(row.trust_level).toBe('restricted')
  })

  it('upgrades a pre-014 database without losing workspaces; existing rows become restricted', () => {
    const db = memoryDb()
    const partial = runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 14),
    )
    expect(partial.ok).toBe(true)
    if (!partial.ok) return
    expect(partial.data.toVersion).toBe(14)

    db.prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-legacy', 'Legacy', 'windows', 'C:\\dev\\legacy', ?, ?)`,
    ).run(AT, AT)

    const upgraded = migrateDatabase(db)
    expect(upgraded.ok).toBe(true)
    if (!upgraded.ok) return
    expect(upgraded.data.fromVersion).toBe(14)
    expect(upgraded.data.toVersion).toBe(16)

    const row = db
      .prepare('SELECT name, trust_level FROM workspaces WHERE id = ?')
      .get('ws-legacy') as { name: string; trust_level: string }
    expect(row).toEqual({ name: 'Legacy', trust_level: 'restricted' })
  })

  it('rejects an unknown trust level via the CHECK constraint', () => {
    const db = memoryDb()
    const migrated = migrateDatabase(db)
    expect(migrated.ok).toBe(true)
    expect(() =>
      db
        .prepare(
          `INSERT INTO workspaces (id, name, runtime_kind, path, trust_level, created_at, updated_at)
           VALUES ('ws-bad', 'Bad', 'windows', 'C:\\dev\\bad', 'unsafe', ?, ?)`,
        )
        .run(AT, AT),
    ).toThrow(/CHECK/u)
  })

  it('is re-runnable: migrating an up-to-date database is a no-op', () => {
    const db = memoryDb()
    expect(migrateDatabase(db).ok).toBe(true)
    const again = migrateDatabase(db)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.data.applied).toEqual([])
    expect(again.data.toVersion).toBe(16)
  })
})
