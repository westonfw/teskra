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
import agentRunPidIdentitySql from './migrations/011_agent_run_pid_identity.sql?raw'
import agentAccountProfilesSql from './migrations/012_agent_account_profiles.sql?raw'
import agentRunAccountProfileSql from './migrations/013_agent_run_account_profile.sql?raw'
import agentExecutionProfilesSql from './migrations/014_agent_execution_profiles.sql?raw'
import workspaceTrustSql from './migrations/015_workspace_trust.sql?raw'
import { normalizeExternalConfigHomes } from './migrations/016_external_config_home_normalize'
import agentRunQueueAndRetrySql from './migrations/017_agent_run_queue_and_retry.sql?raw'

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
    // Table rebuild (ADR-0008), same mechanics as 007: FK must be off so
    // DROP TABLE does not implicit-DELETE the copied rows' dependents.
    foreignKeysOff: true,
  },
  { version: 11, name: '011_agent_run_pid_identity', sql: agentRunPidIdentitySql },
  { version: 12, name: '012_agent_account_profiles', sql: agentAccountProfilesSql },
  { version: 13, name: '013_agent_run_account_profile', sql: agentRunAccountProfileSql },
  { version: 14, name: '014_agent_execution_profiles', sql: agentExecutionProfilesSql },
  { version: 15, name: '015_workspace_trust', sql: workspaceTrustSql },
  {
    version: 16,
    name: '016_external_config_home_normalize',
    // Pure data migration (P2-2 follow-up): no DDL — the run hook rewrites
    // legacy windows-runtime external config_home rows to the normalized
    // storage form (win32.normalize + trailing-separator strip + case-fold).
    sql: '-- 016: data-only migration; the rewrite happens in the run hook',
    run: normalizeExternalConfigHomes,
  },
  { version: 17, name: '017_agent_run_queue_and_retry', sql: agentRunQueueAndRetrySql },
]

/** Brings the database schema up to the latest known version. */
export function migrateDatabase(connection: Database.Database): IpcResult<MigrationRunResult> {
  return runMigrations(connection, MIGRATIONS)
}
