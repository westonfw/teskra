import type Database from 'better-sqlite3'
import { z } from 'zod'

import type { IpcResult } from '@teskra/contracts'

import { execute, isoTimestampSchema, mapRows, nowIso, requireFound, validateRow } from './common'

/**
 * PermissionRepository (TASK-007) — the `permission_rules` and
 * `permission_audit` tables (plan §139.1, 005_permissions.sql lines
 * 5446–5468).
 *
 * ADR-0002: rules are policy input (projected into each Agent CLI's own
 * approval mechanism), audit rows are recorded AFTER the fact from the
 * output stream — there is no pre-execution interception.
 *
 * `risk_level` is free TEXT per §139.1 (the CommandClassifier, TASK-064,
 * owns the level vocabulary), so it is validated as a plain string here;
 * `action` / `scope` have pinned values in the column comments and are
 * validated as enums.
 */

/** §139.1 `permission_rules.action` (line 5452). */
export const PERMISSION_ACTIONS = ['allow', 'deny', 'ask', 'audit'] as const
export const permissionActionSchema = z.enum(PERMISSION_ACTIONS)
export type PermissionAction = z.infer<typeof permissionActionSchema>

/** §139.1 `permission_rules.scope` (line 5453). */
export const PERMISSION_SCOPES = ['once', 'session', 'persistent'] as const
export const permissionScopeSchema = z.enum(PERMISSION_SCOPES)
export type PermissionScope = z.infer<typeof permissionScopeSchema>

export const permissionRuleRecordSchema = z.strictObject({
  id: z.string(),
  /** NULL = global rule. */
  workspaceId: z.string().optional(),
  /** NULL = applies to every agent. */
  agentType: z.string().optional(),
  commandPattern: z.string(),
  riskLevel: z.string().optional(),
  action: permissionActionSchema,
  scope: permissionScopeSchema,
  createdAt: isoTimestampSchema,
})
export type PermissionRule = z.infer<typeof permissionRuleRecordSchema>

export const permissionAuditRecordSchema = z.strictObject({
  id: z.number().int(),
  runId: z.string(),
  command: z.string(),
  cwd: z.string().optional(),
  riskLevel: z.string(),
  matchedRuleId: z.string().optional(),
  /** When the command was detected in the output stream (post-hoc). */
  detectedAt: isoTimestampSchema,
  createdAt: isoTimestampSchema,
})
export type PermissionAuditEntry = z.infer<typeof permissionAuditRecordSchema>

interface RuleRow {
  id: string
  workspace_id: string | null
  agent_type: string | null
  command_pattern: string
  risk_level: string | null
  action: string
  scope: string
  created_at: string
}

interface AuditRow {
  id: number
  run_id: string
  command: string
  cwd: string | null
  risk_level: string
  matched_rule_id: string | null
  detected_at: string
  created_at: string
}

export interface CreatePermissionRuleInput {
  readonly id: string
  readonly commandPattern: string
  readonly action: PermissionAction
  readonly scope: PermissionScope
  readonly workspaceId?: string
  readonly agentType?: string
  readonly riskLevel?: string
}

export interface UpdatePermissionRuleInput {
  readonly commandPattern?: string | undefined
  readonly action?: PermissionAction | undefined
  readonly scope?: PermissionScope | undefined
  readonly riskLevel?: string | null | undefined
}

export interface RecordAuditInput {
  readonly runId: string
  readonly command: string
  readonly riskLevel: string
  readonly cwd?: string
  readonly matchedRuleId?: string
  /** Defaults to the write time. */
  readonly detectedAt?: string
}

/** TASK-065: audit filters for the Manager/UI (`workspaceId` joins agent_runs). */
export interface ListPermissionAuditFilter {
  readonly runId?: string | undefined
  readonly workspaceId?: string | undefined
  readonly riskLevel?: string | undefined
  /** Defaults to 500. */
  readonly limit?: number | undefined
}

export interface PermissionRepository {
  createRule(input: CreatePermissionRuleInput, now?: string): IpcResult<PermissionRule>
  getRuleById(id: string): IpcResult<PermissionRule | null>
  updateRule(id: string, patch: UpdatePermissionRuleInput): IpcResult<PermissionRule | null>
  /**
   * Rules applicable to a context: global rules (workspace_id / agent_type
   * NULL) plus rows matching the given workspace / agent exactly. Only
   * `persistent` rules apply (P1-3) — ephemeral grants are never read from
   * this table.
   */
  listApplicableRules(workspaceId?: string, agentType?: string): IpcResult<PermissionRule[]>
  deleteRule(id: string): IpcResult<boolean>
  recordAudit(input: RecordAuditInput, now?: string): IpcResult<PermissionAuditEntry>
  listAuditByRun(runId: string): IpcResult<PermissionAuditEntry[]>
  /** Filtered audit listing, newest first. `workspaceId` resolves via agent_runs. */
  listAudit(filter?: ListPermissionAuditFilter): IpcResult<PermissionAuditEntry[]>
}

const RULE = 'permission-rule'
const AUDIT = 'permission-audit'

function ruleToDomain(row: RuleRow): IpcResult<PermissionRule> {
  return validateRow(permissionRuleRecordSchema, RULE, {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    agentType: row.agent_type ?? undefined,
    commandPattern: row.command_pattern,
    riskLevel: row.risk_level ?? undefined,
    action: row.action,
    scope: row.scope,
    createdAt: row.created_at,
  })
}

function auditToDomain(row: AuditRow): IpcResult<PermissionAuditEntry> {
  return validateRow(permissionAuditRecordSchema, AUDIT, {
    id: row.id,
    runId: row.run_id,
    command: row.command,
    cwd: row.cwd ?? undefined,
    riskLevel: row.risk_level,
    matchedRuleId: row.matched_rule_id ?? undefined,
    detectedAt: row.detected_at,
    createdAt: row.created_at,
  })
}

export function createPermissionRepository(connection: Database.Database): PermissionRepository {
  const repository: PermissionRepository = {
    createRule(input, now = nowIso()) {
      const inserted = execute(RULE, 'create', () => {
        connection
          .prepare(
            `INSERT INTO permission_rules (id, workspace_id, agent_type, command_pattern, risk_level, action, scope, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.workspaceId ?? null,
            input.agentType ?? null,
            input.commandPattern,
            input.riskLevel ?? null,
            input.action,
            input.scope,
            now,
          )
      })
      if (!inserted.ok) {
        return inserted
      }
      return requireFound(RULE, repository.getRuleById(input.id))
    },

    getRuleById(id) {
      const row = execute(RULE, 'read', () => {
        return connection.prepare('SELECT * FROM permission_rules WHERE id = ?').get(id) as
          RuleRow | undefined
      })
      if (!row.ok) {
        return row
      }
      if (row.data === undefined) {
        return { ok: true, data: null }
      }
      return ruleToDomain(row.data)
    },

    updateRule(id, patch) {
      const sets: string[] = []
      const values: unknown[] = []
      if (patch.commandPattern !== undefined) {
        sets.push('command_pattern = ?')
        values.push(patch.commandPattern)
      }
      if (patch.action !== undefined) {
        sets.push('action = ?')
        values.push(patch.action)
      }
      if (patch.scope !== undefined) {
        sets.push('scope = ?')
        values.push(patch.scope)
      }
      if (patch.riskLevel !== undefined) {
        sets.push('risk_level = ?')
        values.push(patch.riskLevel)
      }
      if (sets.length === 0) {
        return repository.getRuleById(id)
      }
      values.push(id)
      const updated = execute(RULE, 'update', () => {
        return connection
          .prepare(`UPDATE permission_rules SET ${sets.join(', ')} WHERE id = ?`)
          .run(...values).changes
      })
      if (!updated.ok) {
        return updated
      }
      if (updated.data === 0) {
        return { ok: true, data: null }
      }
      return repository.getRuleById(id)
    },

    listApplicableRules(workspaceId, agentType) {
      // P1-3: only persistent rules are policy. 'once' / 'session' grants are
      // ephemeral and live in the PermissionManager's in-memory session
      // decisions; any legacy non-persistent row in this table is inert
      // (it used to apply forever — the opposite of what its scope promised).
      const conditions = ['scope = ?', '(workspace_id IS NULL OR workspace_id = ?)']
      const values: unknown[] = ['persistent', workspaceId ?? null]
      if (agentType !== undefined) {
        conditions.push('(agent_type IS NULL OR agent_type = ?)')
        values.push(agentType)
      }
      const rows = execute(RULE, 'listApplicableRules', () => {
        return connection
          .prepare(
            `SELECT * FROM permission_rules WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`,
          )
          .all(...values) as RuleRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, ruleToDomain)
    },

    deleteRule(id) {
      return execute(RULE, 'delete', () => {
        return connection.prepare('DELETE FROM permission_rules WHERE id = ?').run(id).changes > 0
      })
    },

    recordAudit(input, now = nowIso()) {
      const recorded = execute(AUDIT, 'record', () => {
        const result = connection
          .prepare(
            `INSERT INTO permission_audit (run_id, command, cwd, risk_level, matched_rule_id, detected_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.runId,
            input.command,
            input.cwd ?? null,
            input.riskLevel,
            input.matchedRuleId ?? null,
            input.detectedAt ?? now,
            now,
          )
        return Number(result.lastInsertRowid)
      })
      if (!recorded.ok) {
        return recorded
      }
      const row = execute(AUDIT, 'read', () => {
        return connection
          .prepare('SELECT * FROM permission_audit WHERE id = ?')
          .get(recorded.data) as AuditRow
      })
      if (!row.ok) {
        return row
      }
      return auditToDomain(row.data)
    },

    listAuditByRun(runId) {
      const rows = execute(AUDIT, 'listAuditByRun', () => {
        return connection
          .prepare('SELECT * FROM permission_audit WHERE run_id = ? ORDER BY id ASC')
          .all(runId) as AuditRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, auditToDomain)
    },

    listAudit(filter = {}) {
      const conditions: string[] = []
      const values: unknown[] = []
      if (filter.runId !== undefined) {
        conditions.push('a.run_id = ?')
        values.push(filter.runId)
      }
      if (filter.workspaceId !== undefined) {
        conditions.push('r.workspace_id = ?')
        values.push(filter.workspaceId)
      }
      if (filter.riskLevel !== undefined) {
        conditions.push('a.risk_level = ?')
        values.push(filter.riskLevel)
      }
      const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
      values.push(filter.limit ?? 500)
      const rows = execute(AUDIT, 'listAudit', () => {
        return connection
          .prepare(
            `SELECT a.* FROM permission_audit a
             JOIN agent_runs r ON r.id = a.run_id
             ${where} ORDER BY a.id DESC LIMIT ?`,
          )
          .all(...values) as AuditRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, auditToDomain)
    },
  }

  return repository
}
