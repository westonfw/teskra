import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { runMigrations } from './migrate'
import { MIGRATIONS, migrateDatabase } from './migrations'

/**
 * TASK-095 acceptance for migrations 012/013 (plan §139.1, design doc §8):
 * old databases upgrade automatically without losing historical runs, the
 * migration chain is re-runnable, FK integrity holds, and every new
 * constraint (partial unique index, CHECKs, composite PK) actually bites.
 */

const AT = '2026-09-13T00:00:00.000Z'

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

function insertWorkspace(db: Database.Database, id = 'ws-1'): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
     VALUES (?, 'WS', 'windows', 'C:\\dev\\ws', ?, ?)`,
  ).run(id, AT, AT)
}

function insertRun(db: Database.Database, id: string, workspaceId = 'ws-1'): void {
  db.prepare(
    `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
     VALUES (?, ?, 'codex', 'failed', 'attended', 'runs/' || ?, ?, ?)`,
  ).run(id, workspaceId, id, AT, AT)
}

function insertProfile(db: Database.Database, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: 'acct-1',
    agent_id: 'codex',
    name: 'Codex Personal',
    auth_type: 'subscription',
    runtime_kind: 'wsl',
    wsl_distro: 'ubuntu-22.04',
    config_home: '/home/weston/.teskra/agent-profiles/codex/personal',
    ...overrides,
  }
  db.prepare(
    `INSERT INTO agent_account_profiles
       (id, agent_id, name, auth_type, runtime_kind, wsl_distro, config_home, created_at, updated_at)
     VALUES (@id, @agent_id, @name, @auth_type, @runtime_kind, @wsl_distro, @config_home, @created_at, @updated_at)`,
  ).run({ ...row, created_at: AT, updated_at: AT })
}

function migratedDb(): Database.Database {
  const db = memoryDb()
  const result = migrateDatabase(db)
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  return db
}

describe('migrations 012/013 (TASK-095)', () => {
  it('upgrades a populated v11 database to v13 without losing historical runs', () => {
    const db = memoryDb()
    const upToEleven = runMigrations(db, MIGRATIONS.slice(0, 11))
    expect(upToEleven.ok).toBe(true)
    insertWorkspace(db)
    insertRun(db, 'run-1')
    insertRun(db, 'run-2')

    const upgraded = migrateDatabase(db)
    expect(upgraded).toEqual({
      ok: true,
      data: { fromVersion: 11, toVersion: 16, applied: [12, 13, 14, 15, 16] },
    })

    const runs = db.prepare('SELECT id FROM agent_runs ORDER BY id').all() as { id: string }[]
    expect(runs).toEqual([{ id: 'run-1' }, { id: 'run-2' }])
    // Historical rows gain the new columns as NULL.
    expect(
      db
        .prepare(
          `SELECT account_profile_id, execution_profile_id, profile_snapshot_json, failure_classification_json
           FROM agent_runs WHERE id = 'run-1'`,
        )
        .get(),
    ).toEqual({
      account_profile_id: null,
      execution_profile_id: null,
      profile_snapshot_json: null,
      failure_classification_json: null,
    })
    for (const table of ['agent_account_profiles', 'account_events', 'profile_aliases']) {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      ).toBeDefined()
    }
  })

  it('writes ZERO profile rows during the upgrade — tables only (TASK-113, §51)', () => {
    const db = memoryDb()
    expect(runMigrations(db, MIGRATIONS.slice(0, 11)).ok).toBe(true)
    insertWorkspace(db)
    insertRun(db, 'run-1')
    expect(migrateDatabase(db).ok).toBe(true)

    // §50/§51: no virtual default Profile, no migration-side seeding — the
    // legacy fallback needs no record, so every new table must stay empty.
    for (const table of ['agent_account_profiles', 'account_events', 'profile_aliases']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
    }
  })

  it('is re-runnable: a second migrateDatabase applies nothing', () => {
    const db = migratedDb()
    const second = migrateDatabase(db)
    expect(second).toEqual({ ok: true, data: { fromVersion: 16, toVersion: 16, applied: [] } })
  })

  it('passes foreign_key_check after migrating with rows in place', () => {
    const db = memoryDb()
    expect(runMigrations(db, MIGRATIONS.slice(0, 11)).ok).toBe(true)
    insertWorkspace(db)
    insertRun(db, 'run-1')
    expect(migrateDatabase(db).ok).toBe(true)
    insertProfile(db)
    db.prepare(
      `INSERT INTO profile_aliases (agent_id, kind, alias, profile_id, created_at, updated_at)
       VALUES ('codex', 'account', 'personal', 'acct-1', ?, ?)`,
    ).run(AT, AT)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  describe('idx_agent_account_profiles_home partial unique index', () => {
    it('allows repeated NULL config_home rows', () => {
      const db = migratedDb()
      insertProfile(db, { id: 'acct-1', config_home: null })
      insertProfile(db, { id: 'acct-2', config_home: null })
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_account_profiles').get()).toEqual({
        n: 2,
      })
    })

    it('rejects the same config_home on the same runtime identity', () => {
      const db = migratedDb()
      insertProfile(db, { id: 'acct-1' })
      expect(() => insertProfile(db, { id: 'acct-2' })).toThrow(
        /UNIQUE.*idx_agent_account_profiles_home/,
      )
    })

    it('allows the same config_home in a different distro or runtime kind', () => {
      const db = migratedDb()
      insertProfile(db, { id: 'acct-1' })
      // Same POSIX path, different distro → different filesystems, no conflict.
      insertProfile(db, { id: 'acct-2', wsl_distro: 'debian' })
      // Same literal path under windows → different runtime kind, no conflict.
      insertProfile(db, {
        id: 'acct-3',
        runtime_kind: 'windows',
        wsl_distro: null,
      })
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_account_profiles').get()).toEqual({
        n: 3,
      })
    })
  })

  describe('agent_account_profiles CHECK constraints', () => {
    it('rejects max_concurrent_runs of 0 or negative, allows NULL and >= 1', () => {
      const db = migratedDb()
      const insert = db.prepare(
        `INSERT INTO agent_account_profiles
           (id, agent_id, name, auth_type, runtime_kind, max_concurrent_runs, created_at, updated_at)
         VALUES (?, 'codex', 'P', 'subscription', 'windows', ?, ?, ?)`,
      )
      expect(() => insert.run('acct-zero', 0, AT, AT)).toThrow(/CHECK/)
      expect(() => insert.run('acct-neg', -1, AT, AT)).toThrow(/CHECK/)
      insert.run('acct-one', 1, AT, AT)
      insert.run('acct-null', null, AT, AT)
    })

    it('requires wsl_distro exactly when runtime_kind is wsl', () => {
      const db = migratedDb()
      // wsl without distro → rejected.
      expect(() => insertProfile(db, { id: 'acct-1', wsl_distro: null })).toThrow(/CHECK/)
      // windows with distro → rejected.
      expect(() => insertProfile(db, { id: 'acct-2', runtime_kind: 'windows' })).toThrow(/CHECK/)
      // wsl with distro → accepted.
      insertProfile(db, { id: 'acct-3' })
      // ssh/container runtimes are outside the first phase.
      expect(() =>
        insertProfile(db, { id: 'acct-4', runtime_kind: 'ssh', wsl_distro: null }),
      ).toThrow(/CHECK/)
    })
  })

  describe('profile_aliases', () => {
    function insertAlias(
      db: Database.Database,
      agentId: string,
      kind: string,
      alias: string,
    ): void {
      db.prepare(
        `INSERT INTO profile_aliases (agent_id, kind, alias, profile_id, created_at, updated_at)
         VALUES (?, ?, ?, 'acct-1', ?, ?)`,
      ).run(agentId, kind, alias, AT, AT)
    }

    it('enforces the (agent_id, kind, alias) primary key', () => {
      const db = migratedDb()
      insertAlias(db, 'codex', 'account', 'work')
      expect(() => insertAlias(db, 'codex', 'account', 'work')).toThrow(/PRIMARY KEY|UNIQUE/)
      // Same alias under another agent or kind is a different binding.
      insertAlias(db, 'claude', 'account', 'work')
      insertAlias(db, 'codex', 'execution', 'work')
    })

    it('rejects kinds other than account / execution', () => {
      const db = migratedDb()
      expect(() => insertAlias(db, 'codex', 'tool', 'work')).toThrow(/CHECK/)
    })
  })

  describe('agent_runs identity columns (013)', () => {
    it('writes and reads back all four new columns', () => {
      const db = migratedDb()
      insertWorkspace(db)
      insertRun(db, 'run-1')
      insertProfile(db)
      const snapshot = JSON.stringify({
        accountProfileId: 'acct-1',
        accountProfileName: 'Codex Personal',
      })
      const classification = JSON.stringify({ kind: 'rate-limited', retryable: true })
      db.prepare(
        `UPDATE agent_runs
         SET account_profile_id = 'acct-1',
             execution_profile_id = 'exec-1',
             profile_snapshot_json = ?,
             failure_classification_json = ?
         WHERE id = 'run-1'`,
      ).run(snapshot, classification)
      expect(
        db
          .prepare(
            `SELECT account_profile_id, execution_profile_id, profile_snapshot_json, failure_classification_json
             FROM agent_runs WHERE id = 'run-1'`,
          )
          .get(),
      ).toEqual({
        account_profile_id: 'acct-1',
        execution_profile_id: 'exec-1',
        profile_snapshot_json: snapshot,
        failure_classification_json: classification,
      })
    })

    it('keeps run rows readable when a referenced profile is deleted (weak reference, no FK)', () => {
      const db = migratedDb()
      insertWorkspace(db)
      insertRun(db, 'run-1')
      insertProfile(db)
      db.prepare(`UPDATE agent_runs SET account_profile_id = 'acct-1' WHERE id = 'run-1'`).run()
      db.prepare(`DELETE FROM agent_account_profiles WHERE id = 'acct-1'`).run()
      expect(
        db.prepare('SELECT account_profile_id FROM agent_runs WHERE id = ?').get('run-1'),
      ).toEqual({ account_profile_id: 'acct-1' })
    })
  })

  describe('account_events', () => {
    it('stores events without any run or profile FK', () => {
      const db = migratedDb()
      db.prepare(
        `INSERT INTO account_events (profile_id, event_type, payload_json, created_at)
         VALUES ('acct-1', 'account.created', '{}', ?)`,
      ).run(AT)
      db.prepare(
        `INSERT INTO account_events (event_type, payload_json, created_at)
         VALUES ('account.login_started', '{}', ?)`,
      ).run(AT)
      expect(db.prepare('SELECT COUNT(*) AS n FROM account_events').get()).toEqual({ n: 2 })
    })
  })
})
