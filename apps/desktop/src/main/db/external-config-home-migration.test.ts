import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { initializeLogging, resetLoggingStateForTests } from '../logger'
import { createTeskraPaths } from '../paths'
import { runMigrations } from './migrate'
import { MIGRATIONS, migrateDatabase } from './migrations'
import { normalizeExternalConfigHomes } from './migrations/016_external_config_home_normalize'

/**
 * Migration 016 (P2-2 follow-up, code-review-2026-09-21 §11 Low): legacy
 * windows-runtime EXTERNAL account profiles stored before
 * normalizeExternalConfigHome keep raw user input (mixed case, trailing
 * slash, forward slashes), which bypasses the per-runtime config_home unique
 * index against newly normalized imports. The migration rewrites them to the
 * same normalized form; normalized-value collisions keep the oldest row and
 * skip (with a WARN) later ones instead of crashing.
 */

const AT_OLD = '2026-09-01T00:00:00.000Z'
const AT_NEW = '2026-09-02T00:00:00.000Z'

const openConnections: Database.Database[] = []
const directories: string[] = []

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
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  resetLoggingStateForTests()
})

function insertProfile(
  db: Database.Database,
  row: {
    id: string
    authType?: string
    runtimeKind?: string
    wslDistro?: string | null
    configHome: string
    createdAt?: string
  },
): void {
  db.prepare(
    `INSERT INTO agent_account_profiles
       (id, agent_id, name, auth_type, runtime_kind, wsl_distro, config_home, created_at, updated_at)
     VALUES (@id, 'codex', @id, @authType, @runtimeKind, @wslDistro, @configHome, @createdAt, @createdAt)`,
  ).run({
    id: row.id,
    authType: row.authType ?? 'external',
    runtimeKind: row.runtimeKind ?? 'windows',
    wslDistro: row.wslDistro ?? null,
    configHome: row.configHome,
    createdAt: row.createdAt ?? AT_OLD,
  })
}

function configHomeOf(db: Database.Database, id: string): string {
  const row = db.prepare('SELECT config_home FROM agent_account_profiles WHERE id = ?').get(id) as {
    config_home: string
  }
  return row.config_home
}

/** Builds a v15 database with the given legacy rows, then upgrades to v17. */
function upgradedDb(seed: (db: Database.Database) => void): Database.Database {
  const db = memoryDb()
  const partial = runMigrations(
    db,
    MIGRATIONS.filter((migration) => migration.version <= 15),
  )
  if (!partial.ok) {
    throw new Error(partial.error.message)
  }
  seed(db)
  const upgraded = migrateDatabase(db)
  if (!upgraded.ok) {
    throw new Error(upgraded.error.message)
  }
  expect(upgraded.data.fromVersion).toBe(15)
  expect(upgraded.data.applied).toEqual([16, 17])
  return db
}

describe('migration 016 — external config_home normalization (P2-2 follow-up)', () => {
  it('registers version 16 immediately after 015', () => {
    const index = MIGRATIONS.findIndex((migration) => migration.version === 16)
    expect(index).toBeGreaterThan(-1)
    expect(MIGRATIONS[index]?.name).toBe('016_external_config_home_normalize')
    expect(MIGRATIONS[index - 1]?.version).toBe(15)
  })

  it('normalizes legacy windows external rows (case, trailing slash, forward slashes)', () => {
    const db = upgradedDb((db) => {
      insertProfile(db, { id: 'p-mixed', configHome: 'C:\\Users\\Alice\\.Codex\\' })
      insertProfile(db, { id: 'p-forward', configHome: 'D:/Tools/Codex/' })
      insertProfile(db, { id: 'p-clean', configHome: 'e:\\already\\clean' })
    })

    expect(configHomeOf(db, 'p-mixed')).toBe('c:\\users\\alice\\.codex')
    expect(configHomeOf(db, 'p-forward')).toBe('d:\\tools\\codex')
    // Already-normalized rows are byte-identical after the migration.
    expect(configHomeOf(db, 'p-clean')).toBe('e:\\already\\clean')
  })

  it('leaves wsl external rows and managed windows rows untouched', () => {
    const db = upgradedDb((db) => {
      insertProfile(db, {
        id: 'p-wsl',
        runtimeKind: 'wsl',
        wslDistro: 'ubuntu',
        configHome: '/home/u/.Codex/',
      })
      insertProfile(db, {
        id: 'p-managed',
        authType: 'subscription',
        configHome: 'C:\\Teskra\\Agent-Profiles\\codex\\work',
      })
    })

    expect(configHomeOf(db, 'p-wsl')).toBe('/home/u/.Codex/')
    expect(configHomeOf(db, 'p-managed')).toBe('C:\\Teskra\\Agent-Profiles\\codex\\work')
  })

  it('keeps the oldest row on a normalized-value collision, skips the later one with a WARN', () => {
    resetLoggingStateForTests()
    const logHome = mkdtempSync(join(tmpdir(), 'teskra-migration016-log-'))
    directories.push(logHome)
    const initialized = initializeLogging(createTeskraPaths({ TESKRA_HOME: logHome }), {
      sync: true,
    })
    if (!initialized.ok) throw new Error(initialized.error.message)

    // Raw-byte-distinct at v15, but both normalize to `c:\users\x\.codex`.
    const db = upgradedDb((db) => {
      insertProfile(db, { id: 'p-older', configHome: 'C:\\Users\\X\\.codex', createdAt: AT_OLD })
      insertProfile(db, { id: 'p-newer', configHome: 'c:\\users\\x\\.codex\\', createdAt: AT_NEW })
    })

    // The migration does not crash and the unique index still holds…
    expect(configHomeOf(db, 'p-older')).toBe('c:\\users\\x\\.codex')
    expect(configHomeOf(db, 'p-newer')).toBe('c:\\users\\x\\.codex\\')
    expect(db.pragma('foreign_key_check')).toEqual([])

    // …and the skipped row left a WARN in the account log.
    const records = readFileSync(join(logHome, 'logs', 'account.log'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const warning = records.find(
      (record) =>
        record['msg'] ===
        'Migration 016: external profile normalizes to an already-claimed config_home; row left as stored.',
    )
    expect(warning).toBeDefined()
    expect(warning?.['profileId']).toBe('p-newer')
    expect(warning?.['keptProfileId']).toBe('p-older')
  })

  it('is re-runnable: migrating an up-to-date database is a no-op', () => {
    const db = memoryDb()
    expect(migrateDatabase(db).ok).toBe(true)
    const again = migrateDatabase(db)
    expect(again).toEqual({ ok: true, data: { fromVersion: 17, toVersion: 17, applied: [] } })
  })

  it('normalizeExternalConfigHomes can be invoked directly against an up-to-date database', () => {
    const db = memoryDb()
    expect(migrateDatabase(db).ok).toBe(true)
    insertProfile(db, { id: 'p-direct', configHome: 'C:\\Users\\Direct\\.Codex\\' })
    normalizeExternalConfigHomes(db)
    expect(configHomeOf(db, 'p-direct')).toBe('c:\\users\\direct\\.codex')
  })
})
