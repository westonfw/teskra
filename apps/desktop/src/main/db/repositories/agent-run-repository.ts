import type Database from 'better-sqlite3'

import type {
  AgentFailureClassification,
  AgentRole,
  AgentRun,
  AgentRunProfileSnapshot,
  AgentRunStatus,
  ApprovalMode,
  ExecutionMode,
  IpcResult,
} from '@teskra/contracts'
import {
  agentFailureClassificationSchema,
  agentRunProfileSnapshotSchema,
  agentRunSchema,
} from '@teskra/contracts'

import {
  decodeJson,
  encodeJson,
  execute,
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

export const agentRunRecordSchema = agentRunSchema
export type { AgentRun } from '@teskra/contracts'

interface AgentRunRow {
  id: string
  task_id: string | null
  workspace_id: string
  workflow_run_id: string | null
  workflow_step_id: string | null
  agent_type: string
  role: string | null
  model: string | null
  mode: string | null
  approval_mode: string | null
  status: string
  process_id: string | null
  pid: number | null
  pid_identity: string | null
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
  // 013_agent_run_account_profile (TASK-095): appended by ALTER TABLE.
  account_profile_id: string | null
  execution_profile_id: string | null
  profile_snapshot_json: string | null
  failure_classification_json: string | null
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
  /** ADR-0007: launch mode persisted at create; never updated afterwards. */
  readonly mode?: 'interactive' | 'exec'
  readonly approvalMode?: ApprovalMode
  /** Defaults to 'created'. */
  readonly status?: AgentRunStatus
  readonly worktreeId?: string
  readonly criteriaSetId?: string
  readonly providerSession?: JsonRecord
  readonly prompt?: string
  readonly startedAt?: string
  /** Milestone 24 (migration 013): the runtime identity this run launches with. */
  readonly accountProfileId?: string
  readonly executionProfileId?: string
  /** §7: profile state captured at start — the auditable truth for history. */
  readonly profileSnapshot?: AgentRunProfileSnapshot
  /** ADR-0010: failure classification written post-hoc (TASK-106). */
  readonly failureClassification?: AgentFailureClassification
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
  readonly pidIdentity?: string | null
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
  /** Migration 013 columns; null clears the value. */
  readonly accountProfileId?: string | null
  readonly executionProfileId?: string | null
  readonly profileSnapshot?: AgentRunProfileSnapshot | null
  readonly failureClassification?: AgentFailureClassification | null
}

export interface AgentRunRepository {
  create(input: CreateAgentRunInput, now?: string): IpcResult<AgentRun>
  getById(id: string): IpcResult<AgentRun | null>
  update(id: string, patch: UpdateAgentRunInput, now?: string): IpcResult<AgentRun | null>
  listByTask(taskId: string): IpcResult<AgentRun[]>
  listByWorkflowRun(workflowRunId: string): IpcResult<AgentRun[]>
  listByWorkspace(workspaceId: string): IpcResult<AgentRun[]>
  /** TASK-097: every run that references an account profile (any status). */
  listByAccountProfile(accountProfileId: string): IpcResult<AgentRun[]>
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
  const profileSnapshot = decodeJson(
    agentRunProfileSnapshotSchema,
    ENTITY,
    'profile_snapshot_json',
    row.profile_snapshot_json,
  )
  if (!profileSnapshot.ok) {
    return profileSnapshot
  }
  const failureClassification = decodeJson(
    agentFailureClassificationSchema,
    ENTITY,
    'failure_classification_json',
    row.failure_classification_json,
  )
  if (!failureClassification.ok) {
    return failureClassification
  }
  return validateRow(agentRunRecordSchema, ENTITY, {
    id: row.id,
    taskId: row.task_id ?? undefined,
    workspaceId: row.workspace_id,
    workflowRunId: row.workflow_run_id ?? undefined,
    workflowStepId: row.workflow_step_id ?? undefined,
    agentType: row.agent_type,
    accountProfileId: row.account_profile_id ?? undefined,
    executionProfileId: row.execution_profile_id ?? undefined,
    profileSnapshot: profileSnapshot.data,
    failureClassification: failureClassification.data,
    role: row.role ?? undefined,
    model: row.model ?? undefined,
    mode: row.mode === 'interactive' || row.mode === 'exec' ? row.mode : undefined,
    approvalMode: row.approval_mode ?? undefined,
    status: row.status,
    processId: row.process_id ?? undefined,
    pid: row.pid ?? undefined,
    pidIdentity: row.pid_identity ?? undefined,
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
            `INSERT INTO agent_runs (id, task_id, workspace_id, workflow_run_id, workflow_step_id, agent_type, role, model, mode, approval_mode, status, worktree_id, execution_mode, criteria_set_id, provider_session_json, run_dir, prompt, started_at, account_profile_id, execution_profile_id, profile_snapshot_json, failure_classification_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            input.mode ?? null,
            input.approvalMode ?? null,
            input.status ?? 'created',
            input.worktreeId ?? null,
            input.executionMode,
            input.criteriaSetId ?? null,
            encodeJson(input.providerSession),
            input.runDir,
            input.prompt ?? null,
            input.startedAt ?? null,
            input.accountProfileId ?? null,
            input.executionProfileId ?? null,
            encodeJson(input.profileSnapshot),
            encodeJson(input.failureClassification),
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
        pidIdentity: 'pid_identity',
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
      if (patch.accountProfileId !== undefined) {
        sets.push('account_profile_id = ?')
        values.push(patch.accountProfileId)
      }
      if (patch.executionProfileId !== undefined) {
        sets.push('execution_profile_id = ?')
        values.push(patch.executionProfileId)
      }
      if (patch.profileSnapshot !== undefined) {
        sets.push('profile_snapshot_json = ?')
        values.push(patch.profileSnapshot === null ? null : encodeJson(patch.profileSnapshot))
      }
      if (patch.failureClassification !== undefined) {
        sets.push('failure_classification_json = ?')
        values.push(
          patch.failureClassification === null ? null : encodeJson(patch.failureClassification),
        )
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

    listByAccountProfile(accountProfileId) {
      return queryRows(
        'listByAccountProfile',
        'SELECT * FROM agent_runs WHERE account_profile_id = ? ORDER BY created_at DESC',
        accountProfileId,
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
