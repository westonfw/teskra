import type Database from 'better-sqlite3'

import type { IpcResult } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from '../errors'

/**
 * Database migration mechanism (TASK-006).
 *
 * A migration is an ordered `{ version, name, sql }` record; the canonical
 * registry lives in ./migrations.ts (the 001–005 .sql files holding the
 * plan §139.1 DDL, TASK-090). This module is the mechanism only —
 * it works on any caller-supplied migration list, which is how tests supply
 * their own fixture migrations without touching the canonical files.
 *
 * Guarantees:
 * - Applied versions are recorded in the `schema_migrations` table, whose
 *   creation is built into the mechanism (it is not itself a migration file).
 * - Already-applied migrations never re-run (version comparison only).
 * - Every migration runs in its own transaction; a failure rolls that
 *   migration back and stops the chain with a structured error.
 * - A database newer than the code (DB version > highest known migration)
 *   is a hard error — never silently continued.
 */
export interface Migration {
  /** Strictly positive integer, unique across the list (e.g. 1 for 001_init). */
  readonly version: number
  /** File stem for log/error context (e.g. "001_init"). */
  readonly name: string
  /** Full SQL text, executed with `connection.exec` inside the transaction. */
  readonly sql: string
  /**
   * Table-rebuild migrations (SQLite cannot ALTER COLUMN) must run with
   * foreign_keys OFF, otherwise DROP TABLE fires an implicit DELETE that
   * cascades into referencing tables. The pragma is a no-op inside a
   * transaction, so it is toggled OUTSIDE the migration transaction here,
   * and `foreign_key_check` runs INSIDE the transaction — violations roll
   * the migration back like any other failure.
   */
  readonly foreignKeysOff?: boolean
}

export interface MigrationRunResult {
  readonly fromVersion: number
  readonly toVersion: number
  /** Versions applied during this run, in application order. */
  readonly applied: readonly number[]
}

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
)
`

function migrationError(
  message: string,
  detail: string,
  cause?: unknown,
  code: InternalAppError['code'] = 'UNKNOWN',
): InternalAppError {
  return { code, message, retryable: false, detail, cause }
}

function ensureSchemaMigrationsTable(connection: Database.Database): void {
  connection.exec(SCHEMA_MIGRATIONS_DDL)
}

function currentVersion(connection: Database.Database): number {
  const row = connection.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null
  }
  return row.version ?? 0
}

/**
 * Validates and sorts the migration list. Returns the sorted list, or a
 * VALIDATION_FAILED error for duplicate / invalid versions.
 */
function normalize(migrations: readonly Migration[]): IpcResult<Migration[]> {
  const seen = new Set<number>()
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      return {
        ok: false,
        error: toPublicError(
          migrationError(
            'Invalid database migration definition.',
            `migration ${migration.name}: version must be a positive integer, got ${migration.version}`,
            undefined,
            'VALIDATION_FAILED',
          ),
        ),
      }
    }
    if (seen.has(migration.version)) {
      return {
        ok: false,
        error: toPublicError(
          migrationError(
            'Invalid database migration definition.',
            `duplicate migration version ${migration.version} (${migration.name})`,
            undefined,
            'VALIDATION_FAILED',
          ),
        ),
      }
    }
    seen.add(migration.version)
  }
  return { ok: true, data: [...migrations].sort((a, b) => a.version - b.version) }
}

export function runMigrations(
  connection: Database.Database,
  migrations: readonly Migration[],
): IpcResult<MigrationRunResult> {
  const normalized = normalize(migrations)
  if (!normalized.ok) {
    return normalized
  }
  const sorted = normalized.data

  let fromVersion: number
  try {
    ensureSchemaMigrationsTable(connection)
    fromVersion = currentVersion(connection)
  } catch (cause) {
    return {
      ok: false,
      error: toPublicError(
        migrationError('Failed to read the database schema version.', 'schema_migrations', cause),
      ),
    }
  }

  const codeVersion = sorted.length > 0 ? sorted[sorted.length - 1].version : 0
  if (fromVersion > codeVersion) {
    return {
      ok: false,
      error: toPublicError(
        migrationError(
          `Database schema version ${fromVersion} is newer than this version of Teskra supports (up to ${codeVersion}).`,
          'the database was created by a newer build; refusing to run against an unknown schema',
          undefined,
          'VALIDATION_FAILED',
        ),
      ),
    }
  }

  const applied: number[] = []
  const recordVersion = connection.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  )
  for (const migration of sorted) {
    if (migration.version <= fromVersion) {
      continue
    }
    try {
      if (migration.foreignKeysOff === true) {
        connection.pragma('foreign_keys = OFF')
      }
      try {
        connection.transaction(() => {
          connection.exec(migration.sql)
          if (migration.foreignKeysOff === true) {
            const violations = connection.pragma('foreign_key_check') as unknown[]
            if (violations.length > 0) {
              throw new Error(
                `foreign_key_check reported ${String(violations.length)} violation(s) after the table rebuild`,
              )
            }
          }
          recordVersion.run(migration.version, migration.name, new Date().toISOString())
        })()
      } finally {
        if (migration.foreignKeysOff === true) {
          connection.pragma('foreign_keys = ON')
        }
      }
    } catch (cause) {
      return {
        ok: false,
        error: toPublicError(
          migrationError(
            `Database migration ${migration.name} failed and was rolled back.`,
            `migration ${migration.name} (version ${migration.version}); schema remains at version ${currentVersion(connection)}`,
            cause,
          ),
        ),
      }
    }
    applied.push(migration.version)
  }

  return { ok: true, data: { fromVersion, toVersion: codeVersion, applied } }
}
