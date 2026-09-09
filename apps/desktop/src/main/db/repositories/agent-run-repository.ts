import type Database from 'better-sqlite3'
import { z } from 'zod'

import type {
  AgentRole,
  AgentRunStatus,
  ApprovalMode,
  ExecutionMode,
  IpcResult,
} from '@teskra/contracts'
import {
  agentRoleSchema,
  agentRunStatusSchema,
  approvalModeSchema,
  executionModeSchema,
} from '@teskra/contracts'

import {
  decodeJson,
  encodeJson,
  execute,
  isoTimestampSchema,
  jsonRecordSchema,
  mapRows,
  nowIso,
  requireFound,
  validateRow,
  type JsonRecord,
} from './common'

/**
 * AgentRunRepository (TASK-007) — the `agent_runs` table (plan §139.1,
 * 002_runs.sql lines 5279–5317).
 *
 * `agentType` stays a free-form string (AgentDefinition.id — never a
 * hardcoded enum, per plan §21 / AGENTS.md). Status uses the contracts
 * AgentRunStatus enum including the reconciliation-only `interrupted`.
 * `provider_session_json` (§131 ProviderSessionRef) and `error_json` are
 * opaque JSON objects at this layer; they are decoded and Zod-validated as
 * records, with corrupted data surfacing as VALIDATION_FAILED.
 */

export const agentRunRecordSchema = z.strictObject({
  id: z.string(),
  taskId: z.string().optional(),
  workspaceId: z.string(),
  workflowRunId: z.string().optional(),
  workflowStepId: z.string().optional(),
  agentType: z.string(),
  role: agentRoleSchema.optional(),
  model: z.string().optional(),
  approvalMode: approvalModeSchema.optional(),
  status: agentRunStatusSchema,
  processId: z.string().optional(),
  pid: z.number().int().optional(),
  worktreeId: z.string().optional(),
  executionMode: executionModeSchema,
  criteriaSetId: z.string().optional(),
  providerSession: jsonRecordSchema.optional(),
  runDir: z.string(),
  prompt: z.string().optional(),
  startedAt: isoTimestampSchema.optional(),
  finishedAt: isoTimestampSchema.optional(),
  lastOutputAt: isoTimestampSchema.optional(),
  lastInputAt: isoTimestampSchema.optional(),
  exitCode: z.number().int().optional(),
  error: jsonRecordSchema.optional(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
})
export type AgentRun = z.infer<typeof agentRunRecordSchema>

interface AgentRunRow {
  id: string
  task_id: string | null
  workspace_id: string
  workflow_run_id: string | null
  workflow_step_id: string | null
  agent_type: string
  role: string | null
  model: string | null
  approval_mode: string | null
  status: string
  process_id: string | null
  pid: number | null
  worktree_id: string | null
  execution_mode: string
  criteria_set_id: string | null
  provider_session_json: string | null
  run_dir: string
  prompt: string | null
  started_at: string | null
  finished_at: string | null
  last_output_at: string | null
  last_input_at: string | null
  exit_code: number | null
  error_json: string | null
  created_at: string
  updated_at: string
}

export interface CreateAgentRunInput {
  readonly id: string
  readonly workspaceId: string
  readonly agentType: string
  readonly executionMode: ExecutionMode
  readonly runDir: string
  readonly taskId?: string
  readonly workflowRunId?: string
  readonly workflowStepId?: string
  readonly role?: AgentRole
  readonly model?: string
  readonly approvalMode?: ApprovalMode
  /** Defaults to 'created'. */
  readonly status?: AgentRunStatus
  readonly worktreeId?: string
  readonly criteriaSetId?: string
  readonly providerSession?: JsonRecord
  readonly prompt?: string
  readonly startedAt?: string
}

export interface UpdateAgentRunInput {
  readonly taskId?: string | null
  readonly workflowRunId?: string | null
  readonly workflowStepId?: string | null
  readonly role?: AgentRole | null
  readonly model?: string | null
  readonly approvalMode?: ApprovalMode | null
  readonly status?: AgentRunStatus
  readonly processId?: string | null
  readonly pid?: number | null
  readonly worktreeId?: string | null
  readonly criteriaSetId?: string | null
  readonly providerSession?: JsonRecord | null
  readonly prompt?: string | null
  readonly startedAt?: string | null
  readonly finishedAt?: string | null
  readonly lastOutputAt?: string | null
  readonly lastInputAt?: string | null
  readonly exitCode?: number | null
  readonly error?: JsonRecord | null
}

export interface AgentRunRepository {
  create(input: CreateAgentRunInput, now?: string): IpcResult<AgentRun>
  getById(id: string): IpcResult<AgentRun | null>
  update(id: string, patch: UpdateAgentRunInput, now?: string): IpcResult<AgentRun | null>
  listByTask(taskId: string): IpcResult<AgentRun[]>
  listByWorkflowRun(workflowRunId: string): IpcResult<AgentRun[]>
  listByWorkspace(workspaceId: string): IpcResult<AgentRun[]>
  /** Statuses matching the idx_agent_runs_active partial index. */
  listActive(): IpcResult<AgentRun[]>
  delete(id: string): IpcResult<boolean>
}

const ENTITY = 'agent-run'

function toDomain(row: AgentRunRow): IpcResult<AgentRun> {
  const providerSession = decodeJson(
    jsonRecordSchema,
    ENTITY,
    'provider_session_json',
    row.provider_session_json,
  )
  if (!providerSession.ok) {
    return providerSession
  }
  const error = decodeJson(jsonRecordSchema, ENTITY, 'error_json', row.error_json)
  if (!error.ok) {
    return error
  }
  return validateRow(agentRunRecordSchema, ENTITY, {
    id: row.id,
    taskId: row.task_id ?? undefined,
    workspaceId: row.workspace_id,
    workflowRunId: row.workflow_run_id ?? undefined,
    workflowStepId: row.workflow_step_id ?? undefined,
    agentType: row.agent_type,
    role: row.role ?? undefined,
    model: row.model ?? undefined,
    approvalMode: row.approval_mode ?? undefined,
    status: row.status,
    processId: row.process_id ?? undefined,
    pid: row.pid ?? undefined,
    worktreeId: row.worktree_id ?? undefined,
    executionMode: row.execution_mode,
    criteriaSetId: row.criteria_set_id ?? undefined,
    providerSession: providerSession.data,
    runDir: row.run_dir,
    prompt: row.prompt ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    lastOutputAt: row.last_output_at ?? undefined,
    lastInputAt: row.last_input_at ?? undefined,
    exitCode: row.exit_code ?? undefined,
    error: error.data,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export function createAgentRunRepository(connection: Database.Database): AgentRunRepository {
  const queryRows = (operation: string, sql: string, ...values: unknown[]) => {
    const rows = execute(ENTITY, operation, () => {
      return connection.prepare(sql).all(...values) as AgentRunRow[]
    })
    if (!rows.ok) {
      return rows
    }
    return mapRows(rows.data, toDomain)
  }

  const repository: AgentRunRepository = {
    create(input, now = nowIso()) {
      const inserted = execute(ENTITY, 'create', () => {
        connection
          .prepare(
            `INSERT INTO agent_runs (id, task_id, workspace_id, workflow_run_id, workflow_step_id, agent_type, role, model, approval_mode, status, worktree_id, execution_mode, criteria_set_id, provider_session_json, run_dir, prompt, started_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.taskId ?? null,
            input.workspaceId,
            input.workflowRunId ?? null,
            input.workflowStepId ?? null,
            input.agentType,
            input.role ?? null,
            input.model ?? null,
            input.approvalMode ?? null,
            input.status ?? 'created',
            input.worktreeId ?? null,
            input.executionMode,
            input.criteriaSetId ?? null,
            encodeJson(input.providerSession),
            input.runDir,
            input.prompt ?? null,
            input.startedAt ?? null,
            now,
            now,
          )
      })
      if (!inserted.ok) {
        return inserted
      }
      return requireFound(ENTITY, repository.getById(input.id))
    },

    getById(id) {
      const row = execute(ENTITY, 'read', () => {
        return connection.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as
          AgentRunRow | undefined
      })
      if (!row.ok) {
        return row
      }
      if (row.data === undefined) {
        return { ok: true, data: null }
      }
      return toDomain(row.data)
    },

    update(id, patch, now = nowIso()) {
      const columnByField = {
        taskId: 'task_id',
        workflowRunId: 'workflow_run_id',
        workflowStepId: 'workflow_step_id',
        role: 'role',
        model: 'model',
        approvalMode: 'approval_mode',
        status: 'status',
        processId: 'process_id',
        pid: 'pid',
        worktreeId: 'worktree_id',
        criteriaSetId: 'criteria_set_id',
        prompt: 'prompt',
        startedAt: 'started_at',
        finishedAt: 'finished_at',
        lastOutputAt: 'last_output_at',
        lastInputAt: 'last_input_at',
        exitCode: 'exit_code',
      } as const
      const sets: string[] = []
      const values: unknown[] = []
      for (const [field, column] of Object.entries(columnByField)) {
        const value = patch[field as keyof typeof columnByField]
        if (value !== undefined) {
          sets.push(`${column} = ?`)
          values.push(value)
        }
      }
      if (patch.providerSession !== undefined) {
        sets.push('provider_session_json = ?')
        values.push(patch.providerSession === null ? null : encodeJson(patch.providerSession))
      }
      if (patch.error !== undefined) {
        sets.push('error_json = ?')
        values.push(patch.error === null ? null : encodeJson(patch.error))
      }
      if (sets.length === 0) {
        return repository.getById(id)
      }
      sets.push('updated_at = ?')
      values.push(now, id)
      const updated = execute(ENTITY, 'update', () => {
        return connection
          .prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ?`)
          .run(...values).changes
      })
      if (!updated.ok) {
        return updated
      }
      if (updated.data === 0) {
        return { ok: true, data: null }
      }
      return repository.getById(id)
    },

    listByTask(taskId) {
      return queryRows(
        'listByTask',
        'SELECT * FROM agent_runs WHERE task_id = ? ORDER BY created_at DESC',
        taskId,
      )
    },

    listByWorkflowRun(workflowRunId) {
      return queryRows(
        'listByWorkflowRun',
        'SELECT * FROM agent_runs WHERE workflow_run_id = ? ORDER BY created_at ASC',
        workflowRunId,
      )
    },

    listByWorkspace(workspaceId) {
      return queryRows(
        'listByWorkspace',
        'SELECT * FROM agent_runs WHERE workspace_id = ? ORDER BY created_at DESC',
        workspaceId,
      )
    },

    listActive() {
      return queryRows(
        'listActive',
        `SELECT * FROM agent_runs WHERE status IN ('running', 'preparing', 'queued') ORDER BY created_at ASC`,
      )
    },

    delete(id) {
      return execute(ENTITY, 'delete', () => {
        return connection.prepare('DELETE FROM agent_runs WHERE id = ?').run(id).changes > 0
      })
    },
  }

  return repository
}
