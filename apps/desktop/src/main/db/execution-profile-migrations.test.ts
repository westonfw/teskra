import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { runMigrations } from './migrate'
import { MIGRATIONS, migrateDatabase } from './migrations'

/**
 * TASK-110 acceptance for migration 014 (plan §139.1, design doc §8.2):
 * old databases upgrade automatically, the chain stays re-runnable,
 * foreign_key_check passes, and the account_profile_id FK (RESTRICT
 * semantics — no ON DELETE action) actually bites. First-phase account
 * removal is soft disable (§47.1), never a DELETE, so the FK guards the
 * unexpected hard-delete path only.
 */

const AT = '2026-09-14T00:00:00.000Z'

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

function migratedDb(): Database.Database {
  const db = memoryDb()
  const result = migrateDatabase(db)
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  return db
}

function insertAccountProfile(db: Database.Database, id = 'acct-1', agentId = 'codex'): void {
  db.prepare(
    `INSERT INTO agent_account_profiles
       (id, agent_id, name, auth_type, runtime_kind, created_at, updated_at)
     VALUES (?, ?, 'P', 'subscription', 'windows', ?, ?)`,
  ).run(id, agentId, AT, AT)
}

function insertExecutionProfile(
  db: Database.Database,
  id = 'exec-1',
  accountProfileId: string | null = 'acct-1',
  full = true,
): void {
  db.prepare(
    `INSERT INTO agent_execution_profiles
       (id, name, agent_id, account_profile_id, model, reasoning_effort, approval_mode, created_at, updated_at)
     VALUES (?, 'Codex Personal High', 'codex', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    accountProfileId,
    full ? 'gpt-5-codex' : null,
    full ? 'high' : null,
    full ? 'safe-auto' : null,
    AT,
    AT,
  )
}

describe('migration 014 (TASK-110)', () => {
  it('upgrades a populated v13 database to v14', () => {
    const db = memoryDb()
    expect(runMigrations(db, MIGRATIONS.slice(0, 13)).ok).toBe(true)
    insertAccountProfile(db)

    const upgraded = migrateDatabase(db)
    expect(upgraded).toEqual({
      ok: true,
      data: { fromVersion: 13, toVersion: 17, applied: [14, 15, 16, 17] },
    })
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_execution_profiles'",
        )
        .get(),
    ).toBeDefined()
    // The pre-existing account profile row is untouched.
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_account_profiles').get()).toEqual({ n: 1 })
  })

  it('is re-runnable: a second migrateDatabase applies nothing', () => {
    const db = migratedDb()
    expect(migrateDatabase(db)).toEqual({
      ok: true,
      data: { fromVersion: 17, toVersion: 17, applied: [] },
    })
  })

  it('passes foreign_key_check after migrating with rows in place', () => {
    const db = memoryDb()
    expect(runMigrations(db, MIGRATIONS.slice(0, 13)).ok).toBe(true)
    insertAccountProfile(db)
    expect(migrateDatabase(db).ok).toBe(true)
    insertExecutionProfile(db)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('writes and reads back a full row, nullable columns included', () => {
    const db = migratedDb()
    insertAccountProfile(db)
    insertExecutionProfile(db)
    insertExecutionProfile(db, 'exec-2', null, false)
    expect(
      db
        .prepare(
          `SELECT account_profile_id, model, reasoning_effort, approval_mode
           FROM agent_execution_profiles WHERE id = 'exec-2'`,
        )
        .get(),
    ).toEqual({
      account_profile_id: null,
      model: null,
      reasoning_effort: null,
      approval_mode: null,
    })
  })

  describe('account_profile_id FK (RESTRICT semantics)', () => {
    it('rejects an execution profile pointing at a missing account profile', () => {
      const db = migratedDb()
      expect(() => insertExecutionProfile(db, 'exec-1', 'acct-missing')).toThrow(
        /FOREIGN KEY constraint failed/,
      )
    })

    it('rejects hard-deleting an account profile that an execution profile references', () => {
      const db = migratedDb()
      insertAccountProfile(db)
      insertExecutionProfile(db)
      expect(() =>
        db.prepare(`DELETE FROM agent_account_profiles WHERE id = 'acct-1'`).run(),
      ).toThrow(/FOREIGN KEY constraint failed/)
    })

    it('allows deleting an account profile once no execution profile references it', () => {
      const db = migratedDb()
      insertAccountProfile(db)
      insertAccountProfile(db, 'acct-2')
      insertExecutionProfile(db)
      db.prepare(`DELETE FROM agent_account_profiles WHERE id = 'acct-2'`).run()
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_account_profiles').get()).toEqual({
        n: 1,
      })
    })

    it('allows deleting the execution profile itself (nothing references it)', () => {
      const db = migratedDb()
      insertAccountProfile(db)
      insertExecutionProfile(db)
      db.prepare(`DELETE FROM agent_execution_profiles WHERE id = 'exec-1'`).run()
      db.prepare(`DELETE FROM agent_account_profiles WHERE id = 'acct-1'`).run()
      expect(db.pragma('foreign_key_check')).toEqual([])
    })
  })
})
