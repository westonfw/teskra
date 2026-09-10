import type Database from 'better-sqlite3'

import type { IpcResult } from '@teskra/contracts'

import { runMigrations, type Migration, type MigrationRunResult } from './migrate'
import initSql from './migrations/001_init.sql?raw'
import runsSql from './migrations/002_runs.sql?raw'
import criteriaReviewSql from './migrations/003_criteria_review.sql?raw'
import artifactsMemorySql from './migrations/004_artifacts_memory.sql?raw'
import permissionsSql from './migrations/005_permissions.sql?raw'
import worktreeArchiveSql from './migrations/006_worktree_archive.sql?raw'

/**
 * The canonical migration chain (TASK-006). The .sql files under
 * ./migrations/ are the single source of truth; they are embedded into the
 * main-process bundle via Vite `?raw` imports so the packaged app needs no
 * filesystem access to apply them.
 *
 * File contents are the plan §139.1 authoritative DDL (TASK-090); the
 * migration mechanism itself is TASK-006.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '001_init', sql: initSql },
  { version: 2, name: '002_runs', sql: runsSql },
  { version: 3, name: '003_criteria_review', sql: criteriaReviewSql },
  { version: 4, name: '004_artifacts_memory', sql: artifactsMemorySql },
  { version: 5, name: '005_permissions', sql: permissionsSql },
  { version: 6, name: '006_worktree_archive', sql: worktreeArchiveSql },
]

/** Brings the database schema up to the latest known version. */
export function migrateDatabase(
  connection: Database.Database,
): IpcResult<MigrationRunResult> {
  return runMigrations(connection, MIGRATIONS)
}
