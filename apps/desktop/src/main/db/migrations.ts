import type Database from 'better-sqlite3'

import type { IpcResult } from '@teskra/contracts'

import { runMigrations, type Migration, type MigrationRunResult } from './migrate'
import initSql from './migrations/001_init.sql?raw'
import runsSql from './migrations/002_runs.sql?raw'
import criteriaReviewSql from './migrations/003_criteria_review.sql?raw'
import artifactsMemorySql from './migrations/004_artifacts_memory.sql?raw'
import permissionsSql from './migrations/005_permissions.sql?raw'
import worktreeArchiveSql from './migrations/006_worktree_archive.sql?raw'
import workflowRunTaskOptionalSql from './migrations/007_workflow_run_task_optional.sql?raw'
import workflowRunCriteriaIterationSql from './migrations/008_workflow_run_criteria_iteration.sql?raw'
import agentRunModeSql from './migrations/009_agent_run_mode.sql?raw'
import criteriaSetTaskNullableSql from './migrations/010_criteria_set_task_nullable.sql?raw'

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
  {
    version: 7,
    name: '007_workflow_run_task_optional',
    sql: workflowRunTaskOptionalSql,
    // Table rebuild (TASK-056 / ADR-0006): FK must be off so DROP TABLE does
    // not implicit-DELETE the copied rows' dependents; checked in-transaction.
    foreignKeysOff: true,
  },
  { version: 8, name: '008_workflow_run_criteria_iteration', sql: workflowRunCriteriaIterationSql },
  { version: 9, name: '009_agent_run_mode', sql: agentRunModeSql },
  {
    version: 10,
    name: '010_criteria_set_task_nullable',
    sql: criteriaSetTaskNullableSql,
    // Table rebuild (ADR-0007), same mechanics as 007: FK must be off so
    // DROP TABLE does not implicit-DELETE the copied rows' dependents.
    foreignKeysOff: true,
  },
]

/** Brings the database schema up to the latest known version. */
export function migrateDatabase(connection: Database.Database): IpcResult<MigrationRunResult> {
  return runMigrations(connection, MIGRATIONS)
}
