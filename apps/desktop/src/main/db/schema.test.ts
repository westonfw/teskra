import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from './migrations'

/**
 * TASK-090 acceptance: the migrated schema must match plan §139.1 exactly
 * (docs/teskra-implementation-plan-v2.md lines 5187–5518). Every expectation
 * below is hardcoded from that section — `source` cites the authoritative
 * plan line range so a schema change must be reflected here deliberately.
 */

// [name, type, notnull, dflt_value, pk] mirroring PRAGMA table_info rows.
type ColumnSpec = readonly [string, string, 0 | 1, string | null, 0 | 1]

interface ForeignKeySpec {
  readonly from: string
  readonly table: string
  readonly to: string
  readonly onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'
}

interface IndexSpec {
  readonly name: string
  readonly unique: boolean
  readonly partial: boolean
  // null marks an expression column (e.g. IFNULL(wsl_distro,'')).
  readonly columns: readonly (string | null)[]
}

interface TableSpec {
  readonly source: string
  readonly columns: readonly ColumnSpec[]
  readonly foreignKeys: readonly ForeignKeySpec[]
  readonly indexes: readonly IndexSpec[]
}

const SCHEMA: Record<string, TableSpec> = {
  workspaces: {
    source: '§139.1 lines 5196–5213',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      ['name', 'TEXT', 1, null, 0],
      ['runtime_kind', 'TEXT', 1, null, 0],
      ['wsl_distro', 'TEXT', 0, null, 0],
      ['ssh_host', 'TEXT', 0, null, 0],
      ['container_id', 'TEXT', 0, null, 0],
      ['path', 'TEXT', 1, null, 0],
      ['git_root', 'TEXT', 0, null, 0],
      ['default_branch', 'TEXT', 0, null, 0],
      ['env_json', 'TEXT', 0, null, 0],
      ['last_opened_at', 'TEXT', 0, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
      ['updated_at', 'TEXT', 1, null, 0],
    ],
    foreignKeys: [],
    indexes: [
      {
        name: 'idx_workspaces_runtime_path',
        unique: true,
        partial: false,
        columns: ['runtime_kind', null, 'path'],
      },
    ],
  },
  tasks: {
    source: '§139.1 lines 5215–5226',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      ['workspace_id', 'TEXT', 1, null, 0],
      ['title', 'TEXT', 1, null, 0],
      ['description', 'TEXT', 0, null, 0],
      ['status', 'TEXT', 1, null, 0],
      ['archived_at', 'TEXT', 0, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
      ['updated_at', 'TEXT', 1, null, 0],
    ],
    foreignKeys: [{ from: 'workspace_id', table: 'workspaces', to: 'id', onDelete: 'CASCADE' }],
    indexes: [
      {
        name: 'idx_tasks_workspace_status',
        unique: false,
        partial: false,
        columns: ['workspace_id', 'status'],
      },
    ],
  },
  worktrees: {
    source:
      '§139.1 lines 5232–5247 + idx_worktrees_run (line 5518, 循环引用处理) + 006_worktree_archive (TASK-047)',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      ['workspace_id', 'TEXT', 1, null, 0],
      ['run_id', 'TEXT', 0, null, 0],
      ['branch', 'TEXT', 1, null, 0],
      ['base_branch', 'TEXT', 1, null, 0],
      ['path', 'TEXT', 1, null, 0],
      ['state', 'TEXT', 1, null, 0],
      ['isolation', 'TEXT', 1, null, 0],
      ['merged_at', 'TEXT', 0, null, 0],
      ['discarded_at', 'TEXT', 0, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
      ['updated_at', 'TEXT', 1, null, 0],
      // 006_worktree_archive (TASK-047): ALTER TABLE appends at the end.
      ['archived_at', 'TEXT', 0, null, 0],
    ],
    // run_id 故意不设 FK（与 agent_runs.worktree_id 的循环引用，§139.1 lines 5493–5516）
    foreignKeys: [{ from: 'workspace_id', table: 'workspaces', to: 'id', onDelete: 'CASCADE' }],
    indexes: [
      {
        name: 'idx_worktrees_workspace_state',
        unique: false,
        partial: false,
        columns: ['workspace_id', 'state'],
      },
      { name: 'idx_worktrees_run', unique: false, partial: false, columns: ['run_id'] },
      {
        name: 'idx_worktrees_workspace_archived',
        unique: false,
        partial: false,
        columns: ['workspace_id', 'archived_at'],
      },
    ],
  },
  workflow_runs: {
    source:
      '§139.1 lines 5249–5261, task_id overridden by ADR-0006 / 007_workflow_run_task_optional (TASK-056)',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      // ADR-0006: nullable — a WorkflowRun can exist independently of any Task.
      ['task_id', 'TEXT', 0, null, 0],
      ['workflow_definition_id', 'TEXT', 1, null, 0],
      ['definition_json', 'TEXT', 1, null, 0],
      ['status', 'TEXT', 1, null, 0],
      ['current_iteration', 'INTEGER', 1, '0', 0],
      ['total_iterations', 'INTEGER', 1, '0', 0],
      ['criteria_set_id', 'TEXT', 0, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
      ['completed_at', 'TEXT', 0, null, 0],
      // 008_workflow_run_criteria_iteration (TASK-062): ALTER TABLE appends at the end.
      ['criteria_iteration', 'INTEGER', 1, '0', 0],
    ],
    foreignKeys: [
      // ADR-0006: SET NULL like agent_runs.task_id — 删除 Task 保留执行历史。
      { from: 'task_id', table: 'tasks', to: 'id', onDelete: 'SET NULL' },
      {
        from: 'criteria_set_id',
        table: 'acceptance_criteria_sets',
        to: 'id',
        onDelete: 'RESTRICT',
      },
    ],
    indexes: [
      {
        name: 'idx_workflow_runs_task',
        unique: false,
        partial: false,
        columns: ['task_id', 'status'],
      },
    ],
  },
  workflow_steps: {
    source: '§139.1 lines 5263–5277',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      ['workflow_run_id', 'TEXT', 1, null, 0],
      ['node_id', 'TEXT', 1, null, 0],
      ['node_type', 'TEXT', 1, null, 0],
      ['status', 'TEXT', 1, null, 0],
      ['iteration', 'INTEGER', 1, '0', 0],
      ['attempt', 'INTEGER', 1, '1', 0],
      ['depends_on_json', 'TEXT', 0, null, 0],
      ['result_json', 'TEXT', 0, null, 0],
      ['started_at', 'TEXT', 0, null, 0],
      ['finished_at', 'TEXT', 0, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
    ],
    foreignKeys: [
      { from: 'workflow_run_id', table: 'workflow_runs', to: 'id', onDelete: 'CASCADE' },
    ],
    indexes: [
      {
        name: 'idx_workflow_steps_run',
        unique: false,
        partial: false,
        columns: ['workflow_run_id', 'status'],
      },
    ],
  },
  agent_runs: {
    source: '§139.1 lines 5279–5317',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      ['task_id', 'TEXT', 0, null, 0],
      ['workspace_id', 'TEXT', 1, null, 0],
      ['workflow_run_id', 'TEXT', 0, null, 0],
      ['workflow_step_id', 'TEXT', 0, null, 0],
      ['agent_type', 'TEXT', 1, null, 0],
      ['role', 'TEXT', 0, null, 0],
      ['model', 'TEXT', 0, null, 0],
      ['approval_mode', 'TEXT', 0, null, 0],
      ['status', 'TEXT', 1, null, 0],
      ['process_id', 'TEXT', 0, null, 0],
      ['pid', 'INTEGER', 0, null, 0],
      ['worktree_id', 'TEXT', 0, null, 0],
      ['execution_mode', 'TEXT', 1, null, 0],
      ['criteria_set_id', 'TEXT', 0, null, 0],
      ['provider_session_json', 'TEXT', 0, null, 0],
      ['run_dir', 'TEXT', 1, null, 0],
      ['prompt', 'TEXT', 0, null, 0],
      ['started_at', 'TEXT', 0, null, 0],
      ['finished_at', 'TEXT', 0, null, 0],
      ['last_output_at', 'TEXT', 0, null, 0],
      ['last_input_at', 'TEXT', 0, null, 0],
      ['exit_code', 'INTEGER', 0, null, 0],
      ['error_json', 'TEXT', 0, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
      ['updated_at', 'TEXT', 1, null, 0],
    ],
    foreignKeys: [
      { from: 'task_id', table: 'tasks', to: 'id', onDelete: 'SET NULL' },
      { from: 'workspace_id', table: 'workspaces', to: 'id', onDelete: 'CASCADE' },
      { from: 'workflow_run_id', table: 'workflow_runs', to: 'id', onDelete: 'SET NULL' },
      { from: 'workflow_step_id', table: 'workflow_steps', to: 'id', onDelete: 'SET NULL' },
      { from: 'worktree_id', table: 'worktrees', to: 'id', onDelete: 'SET NULL' },
      {
        from: 'criteria_set_id',
        table: 'acceptance_criteria_sets',
        to: 'id',
        onDelete: 'RESTRICT',
      },
    ],
    indexes: [
      {
        name: 'idx_agent_runs_task',
        unique: false,
        partial: false,
        columns: ['task_id', 'created_at'],
      },
      { name: 'idx_agent_runs_active', unique: false, partial: true, columns: ['status'] },
      {
        name: 'idx_agent_runs_workflow',
        unique: false,
        partial: false,
        columns: ['workflow_run_id'],
      },
    ],
  },
  agent_events: {
    source: '§139.1 lines 5319–5327',
    columns: [
      ['id', 'INTEGER', 0, null, 1],
      ['run_id', 'TEXT', 1, null, 0],
      ['seq', 'INTEGER', 1, null, 0],
      ['event_type', 'TEXT', 1, null, 0],
      ['payload_json', 'TEXT', 1, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
    ],
    foreignKeys: [{ from: 'run_id', table: 'agent_runs', to: 'id', onDelete: 'CASCADE' }],
    indexes: [
      {
        name: 'idx_agent_events_run_seq',
        unique: true,
        partial: false,
        columns: ['run_id', 'seq'],
      },
    ],
  },
  acceptance_criteria_sets: {
    source: '§139.1 lines 5333–5342',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      ['task_id', 'TEXT', 1, null, 0],
      ['version', 'INTEGER', 1, null, 0],
      ['status', 'TEXT', 1, null, 0],
      ['confirmed_at', 'TEXT', 0, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
    ],
    foreignKeys: [{ from: 'task_id', table: 'tasks', to: 'id', onDelete: 'CASCADE' }],
    indexes: [
      {
        name: 'idx_criteria_sets_task_version',
        unique: true,
        partial: false,
        columns: ['task_id', 'version'],
      },
    ],
  },
  acceptance_criteria: {
    source: '§139.1 lines 5344–5353',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      ['criteria_set_id', 'TEXT', 1, null, 0],
      ['ordinal', 'INTEGER', 1, null, 0],
      ['description', 'TEXT', 1, null, 0],
      ['category', 'TEXT', 0, null, 0],
      ['required', 'INTEGER', 1, '1', 0],
      ['created_at', 'TEXT', 1, null, 0],
    ],
    foreignKeys: [
      {
        from: 'criteria_set_id',
        table: 'acceptance_criteria_sets',
        to: 'id',
        onDelete: 'CASCADE',
      },
    ],
    indexes: [
      {
        name: 'idx_criteria_set',
        unique: false,
        partial: false,
        columns: ['criteria_set_id', 'ordinal'],
      },
    ],
  },
  review_panels: {
    source: '§139.1 lines 5355–5366',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      ['task_id', 'TEXT', 1, null, 0],
      ['workflow_run_id', 'TEXT', 0, null, 0],
      ['target_artifact_id', 'TEXT', 0, null, 0],
      ['criteria_set_id', 'TEXT', 0, null, 0],
      ['status', 'TEXT', 1, null, 0],
      ['consensus', 'TEXT', 0, null, 0],
      ['aggregate_json', 'TEXT', 0, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
      ['completed_at', 'TEXT', 0, null, 0],
    ],
    foreignKeys: [
      { from: 'task_id', table: 'tasks', to: 'id', onDelete: 'CASCADE' },
      { from: 'workflow_run_id', table: 'workflow_runs', to: 'id', onDelete: 'SET NULL' },
      { from: 'target_artifact_id', table: 'artifacts', to: 'id', onDelete: 'RESTRICT' },
      {
        from: 'criteria_set_id',
        table: 'acceptance_criteria_sets',
        to: 'id',
        onDelete: 'RESTRICT',
      },
    ],
    indexes: [],
  },
  review_panel_members: {
    source: '§139.1 lines 5368–5375',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      ['panel_id', 'TEXT', 1, null, 0],
      ['run_id', 'TEXT', 1, null, 0],
      ['agent_id', 'TEXT', 1, null, 0],
      ['verdict', 'TEXT', 0, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
    ],
    foreignKeys: [
      { from: 'panel_id', table: 'review_panels', to: 'id', onDelete: 'CASCADE' },
      { from: 'run_id', table: 'agent_runs', to: 'id', onDelete: 'CASCADE' },
    ],
    indexes: [],
  },
  review_findings: {
    source: '§139.1 lines 5377–5390',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      ['run_id', 'TEXT', 1, null, 0],
      ['panel_id', 'TEXT', 0, null, 0],
      ['severity', 'TEXT', 1, null, 0],
      ['title', 'TEXT', 1, null, 0],
      ['description', 'TEXT', 0, null, 0],
      ['file', 'TEXT', 0, null, 0],
      ['line', 'INTEGER', 0, null, 0],
      ['criterion_id', 'TEXT', 0, null, 0],
      ['evidence_json', 'TEXT', 0, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
    ],
    foreignKeys: [
      { from: 'run_id', table: 'agent_runs', to: 'id', onDelete: 'CASCADE' },
      { from: 'panel_id', table: 'review_panels', to: 'id', onDelete: 'CASCADE' },
      // §139.1 line 5386：无显式 ON DELETE，默认 NO ACTION
      { from: 'criterion_id', table: 'acceptance_criteria', to: 'id', onDelete: 'NO ACTION' },
    ],
    indexes: [
      {
        name: 'idx_findings_panel_severity',
        unique: false,
        partial: false,
        columns: ['panel_id', 'severity'],
      },
    ],
  },
  criterion_scores: {
    source: '§139.1 lines 5392–5400',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      ['run_id', 'TEXT', 1, null, 0],
      ['criterion_id', 'TEXT', 1, null, 0],
      ['result', 'TEXT', 1, null, 0],
      ['evidence_json', 'TEXT', 0, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
    ],
    foreignKeys: [
      { from: 'run_id', table: 'agent_runs', to: 'id', onDelete: 'CASCADE' },
      { from: 'criterion_id', table: 'acceptance_criteria', to: 'id', onDelete: 'CASCADE' },
    ],
    indexes: [
      {
        name: 'idx_scores_run_criterion',
        unique: true,
        partial: false,
        columns: ['run_id', 'criterion_id'],
      },
    ],
  },
  artifacts: {
    source: '§139.1 lines 5406–5417',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      ['task_id', 'TEXT', 1, null, 0],
      ['run_id', 'TEXT', 0, null, 0],
      ['type', 'TEXT', 1, null, 0],
      ['name', 'TEXT', 1, null, 0],
      ['content', 'TEXT', 0, null, 0],
      ['file_path', 'TEXT', 0, null, 0],
      ['metadata_json', 'TEXT', 0, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
    ],
    foreignKeys: [
      { from: 'task_id', table: 'tasks', to: 'id', onDelete: 'CASCADE' },
      { from: 'run_id', table: 'agent_runs', to: 'id', onDelete: 'SET NULL' },
    ],
    indexes: [
      {
        name: 'idx_artifacts_task_type',
        unique: false,
        partial: false,
        columns: ['task_id', 'type'],
      },
    ],
  },
  handoffs: {
    source: '§139.1 lines 5419–5429',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      ['run_id', 'TEXT', 1, null, 0],
      ['type', 'TEXT', 1, null, 0],
      ['payload_json', 'TEXT', 0, null, 0],
      ['raw_path', 'TEXT', 0, null, 0],
      ['parse_status', 'TEXT', 1, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
    ],
    foreignKeys: [{ from: 'run_id', table: 'agent_runs', to: 'id', onDelete: 'CASCADE' }],
    indexes: [{ name: 'idx_handoffs_run', unique: true, partial: false, columns: ['run_id'] }],
  },
  memories: {
    source: '§139.1 lines 5431–5440',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      ['workspace_id', 'TEXT', 1, null, 0],
      ['type', 'TEXT', 1, null, 0],
      ['content', 'TEXT', 1, null, 0],
      ['source', 'TEXT', 0, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
      ['updated_at', 'TEXT', 1, null, 0],
    ],
    foreignKeys: [{ from: 'workspace_id', table: 'workspaces', to: 'id', onDelete: 'CASCADE' }],
    indexes: [
      {
        name: 'idx_memories_workspace_type',
        unique: false,
        partial: false,
        columns: ['workspace_id', 'type'],
      },
    ],
  },
  permission_rules: {
    source: '§139.1 lines 5446–5456',
    columns: [
      ['id', 'TEXT', 0, null, 1],
      ['workspace_id', 'TEXT', 0, null, 0],
      ['agent_type', 'TEXT', 0, null, 0],
      ['command_pattern', 'TEXT', 1, null, 0],
      ['risk_level', 'TEXT', 0, null, 0],
      ['action', 'TEXT', 1, null, 0],
      ['scope', 'TEXT', 1, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
    ],
    foreignKeys: [{ from: 'workspace_id', table: 'workspaces', to: 'id', onDelete: 'CASCADE' }],
    indexes: [
      {
        name: 'idx_permission_rules_ws',
        unique: false,
        partial: false,
        columns: ['workspace_id', 'agent_type'],
      },
    ],
  },
  permission_audit: {
    source: '§139.1 lines 5458–5468',
    columns: [
      ['id', 'INTEGER', 0, null, 1],
      ['run_id', 'TEXT', 1, null, 0],
      ['command', 'TEXT', 1, null, 0],
      ['cwd', 'TEXT', 0, null, 0],
      ['risk_level', 'TEXT', 1, null, 0],
      ['matched_rule_id', 'TEXT', 0, null, 0],
      ['detected_at', 'TEXT', 1, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
    ],
    foreignKeys: [
      { from: 'run_id', table: 'agent_runs', to: 'id', onDelete: 'CASCADE' },
      { from: 'matched_rule_id', table: 'permission_rules', to: 'id', onDelete: 'SET NULL' },
    ],
    indexes: [
      {
        name: 'idx_permission_audit_run',
        unique: false,
        partial: false,
        columns: ['run_id', 'risk_level'],
      },
    ],
  },
}

const openConnections: Database.Database[] = []

function migratedDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  openConnections.push(db)
  const result = migrateDatabase(db)
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  return db
}

afterEach(() => {
  for (const connection of openConnections.splice(0)) {
    connection.close()
  }
})

describe('schema matches plan §139.1 (TASK-090)', () => {
  it('creates exactly the §139.1 tables (plus the TASK-006 schema_migrations)', () => {
    const db = migratedDb()
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string
      }[]
    )
      .map((row) => row.name)
      // sqlite_sequence only materializes after the first AUTOINCREMENT insert.
      .filter((name) => name !== 'sqlite_sequence')
    expect(tables).toEqual([...Object.keys(SCHEMA), 'schema_migrations'].sort())
  })

  for (const [table, spec] of Object.entries(SCHEMA)) {
    it(`${table} columns match ${spec.source}`, () => {
      const db = migratedDb()
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string
        type: string
        notnull: 0 | 1
        dflt_value: string | null
        pk: 0 | 1
      }[]
      const actual: ColumnSpec[] = rows.map((row) => [
        row.name,
        row.type,
        row.notnull,
        row.dflt_value,
        row.pk,
      ])
      expect(actual).toEqual(spec.columns)
    })

    it(`${table} foreign keys match ${spec.source}`, () => {
      const db = migratedDb()
      const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
        table: string
        from: string
        to: string
        on_delete: string
      }[]
      const actual = rows
        .map((row) => ({ from: row.from, table: row.table, to: row.to, onDelete: row.on_delete }))
        .sort((a, b) => a.from.localeCompare(b.from))
      expect(actual).toEqual([...spec.foreignKeys].sort((a, b) => a.from.localeCompare(b.from)))
    })

    it(`${table} indexes match ${spec.source}`, () => {
      const db = migratedDb()
      const listed = (
        db.prepare(`PRAGMA index_list(${table})`).all() as {
          name: string
          unique: 0 | 1
          origin: string
          partial: 0 | 1
        }[]
      ).filter((row) => row.origin === 'c')
      const actual = listed
        .map((row) => {
          const columns = (
            db.prepare(`PRAGMA index_info(${row.name})`).all() as {
              name: string | null
            }[]
          ).map((col) => col.name)
          return {
            name: row.name,
            unique: row.unique === 1,
            partial: row.partial === 1,
            columns,
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
      expect(actual).toEqual([...spec.indexes].sort((a, b) => a.name.localeCompare(b.name)))
    })
  }

  it('index SQL keeps the §139.1 expressions verbatim (IFNULL / DESC / partial WHERE)', () => {
    const db = migratedDb()
    const indexSql = (name: string): string => {
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(name) as { sql: string }
      return row.sql
    }
    expect(indexSql('idx_workspaces_runtime_path')).toContain("IFNULL(wsl_distro,'')")
    expect(indexSql('idx_agent_runs_task')).toContain('created_at DESC')
    expect(indexSql('idx_agent_runs_active')).toContain(
      "WHERE status IN ('running','preparing','queued')",
    )
  })

  it('agent_events and permission_audit use INTEGER PRIMARY KEY AUTOINCREMENT', () => {
    const db = migratedDb()
    for (const table of ['agent_events', 'permission_audit']) {
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql: string }
      expect(row.sql).toContain('INTEGER PRIMARY KEY AUTOINCREMENT')
    }
  })
})
