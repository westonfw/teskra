import type Database from 'better-sqlite3'
import { z } from 'zod'

import type {
  IpcResult,
  WorkflowNodeType,
  WorkflowRunStatus,
  WorkflowStepStatus,
} from '@teskra/contracts'
import { workflowDefinitionSchema, workflowRunSchema, workflowStepSchema } from '@teskra/contracts'

import {
  decodeJson,
  encodeJson,
  execute,
  jsonRecordSchema,
  mapRows,
  nowIso,
  requireFound,
  validateRow,
} from './common'

/**
 * WorkflowRunRepository (TASK-007; TASK-056 revisions) — the `workflow_runs`
 * and `workflow_steps` tables (plan §139.1, 002_runs.sql lines 5249–5277 as
 * amended by 007_workflow_run_task_optional / ADR-0006). Steps are an
 * aggregate of their run, so both live behind one repository and the Manager
 * layer still never touches SQL.
 *
 * `definition_json` is the launch-time definition snapshot (NOT NULL),
 * validated against the TASK-055 WorkflowDefinition schema on every read —
 * a restarted app must be able to interpret the snapshot. `depends_on_json`
 * is a string array of WorkflowNode ids; `result_json` is an opaque node
 * result object.
 *
 * TASK-056 / ADR-0006: `task_id` is nullable (WorkflowRun 独立于 Task), so
 * `taskId` is optional on both the record and the create input.
 */

export const workflowRunRecordSchema = workflowRunSchema
export type WorkflowRun = z.infer<typeof workflowRunRecordSchema>

export const workflowStepRecordSchema = workflowStepSchema
export type WorkflowStep = z.infer<typeof workflowStepRecordSchema>

interface WorkflowRunRow {
  id: string
  task_id: string | null
  workflow_definition_id: string
  definition_json: string
  status: string
  current_iteration: number
  total_iterations: number
  criteria_iteration: number
  criteria_set_id: string | null
  created_at: string
  completed_at: string | null
}

interface WorkflowStepRow {
  id: string
  workflow_run_id: string
  node_id: string
  node_type: string
  status: string
  iteration: number
  attempt: number
  depends_on_json: string | null
  result_json: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
}

export interface CreateWorkflowRunInput {
  readonly id: string
  /** Optional since ADR-0006: the run may be independent of any Task. */
  readonly taskId?: string
  readonly workflowDefinitionId: string
  readonly definition: WorkflowRun['definition']
  /** Defaults to 'created'. */
  readonly status?: WorkflowRunStatus
  readonly currentIteration?: number
  readonly totalIterations?: number
  readonly criteriaSetId?: string
}

export interface UpdateWorkflowRunInput {
  readonly status?: WorkflowRunStatus
  readonly currentIteration?: number
  readonly totalIterations?: number
  /** TASK-062: re-anchoring the per-version round counter (null clears the anchor). */
  readonly criteriaSetId?: string | null
  readonly criteriaIteration?: number
  readonly completedAt?: string | null
}

export interface CreateWorkflowStepInput {
  readonly id: string
  readonly workflowRunId: string
  readonly nodeId: string
  readonly nodeType: WorkflowNodeType
  /** Defaults to 'pending'. */
  readonly status?: WorkflowStepStatus
  readonly iteration?: number
  readonly attempt?: number
  readonly dependsOn?: readonly string[]
}

export interface UpdateWorkflowStepInput {
  readonly status?: WorkflowStepStatus
  readonly attempt?: number
  readonly result?: Record<string, unknown> | null
  readonly startedAt?: string | null
  readonly finishedAt?: string | null
}

export interface WorkflowRunRepository {
  createRun(input: CreateWorkflowRunInput, now?: string): IpcResult<WorkflowRun>
  getRunById(id: string): IpcResult<WorkflowRun | null>
  updateRun(id: string, patch: UpdateWorkflowRunInput): IpcResult<WorkflowRun | null>
  listRunsByTask(taskId: string, status?: WorkflowRunStatus): IpcResult<WorkflowRun[]>
  /** All runs (including task-less ones), optionally filtered by status. */
  listRuns(status?: WorkflowRunStatus): IpcResult<WorkflowRun[]>
  createStep(input: CreateWorkflowStepInput, now?: string): IpcResult<WorkflowStep>
  getStepById(id: string): IpcResult<WorkflowStep | null>
  updateStep(id: string, patch: UpdateWorkflowStepInput): IpcResult<WorkflowStep | null>
  listSteps(workflowRunId: string): IpcResult<WorkflowStep[]>
  deleteRun(id: string): IpcResult<boolean>
}

const RUN_ENTITY = 'workflow-run'
const STEP_ENTITY = 'workflow-step'

function runToDomain(row: WorkflowRunRow): IpcResult<WorkflowRun> {
  const definition = decodeJson(
    workflowDefinitionSchema,
    RUN_ENTITY,
    'definition_json',
    row.definition_json,
  )
  if (!definition.ok) {
    return definition
  }
  return validateRow(workflowRunRecordSchema, RUN_ENTITY, {
    id: row.id,
    taskId: row.task_id ?? undefined,
    workflowDefinitionId: row.workflow_definition_id,
    definition: definition.data,
    status: row.status,
    currentIteration: row.current_iteration,
    totalIterations: row.total_iterations,
    criteriaIteration: row.criteria_iteration,
    criteriaSetId: row.criteria_set_id ?? undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  })
}

function stepToDomain(row: WorkflowStepRow): IpcResult<WorkflowStep> {
  const dependsOn = decodeJson(
    z.array(z.string()),
    STEP_ENTITY,
    'depends_on_json',
    row.depends_on_json,
  )
  if (!dependsOn.ok) {
    return dependsOn
  }
  const result = decodeJson(jsonRecordSchema, STEP_ENTITY, 'result_json', row.result_json)
  if (!result.ok) {
    return result
  }
  return validateRow(workflowStepRecordSchema, STEP_ENTITY, {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    nodeId: row.node_id,
    nodeType: row.node_type,
    status: row.status,
    iteration: row.iteration,
    attempt: row.attempt,
    dependsOn: dependsOn.data,
    result: result.data,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    createdAt: row.created_at,
  })
}

export function createWorkflowRunRepository(connection: Database.Database): WorkflowRunRepository {
  const repository: WorkflowRunRepository = {
    createRun(input, now = nowIso()) {
      const inserted = execute(RUN_ENTITY, 'create', () => {
        connection
          .prepare(
            `INSERT INTO workflow_runs (id, task_id, workflow_definition_id, definition_json, status, current_iteration, total_iterations, criteria_set_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.taskId ?? null,
            input.workflowDefinitionId,
            encodeJson(input.definition) as string,
            input.status ?? 'created',
            input.currentIteration ?? 0,
            input.totalIterations ?? 0,
            input.criteriaSetId ?? null,
            now,
          )
      })
      if (!inserted.ok) {
        return inserted
      }
      return requireFound(RUN_ENTITY, repository.getRunById(input.id))
    },

    getRunById(id) {
      const row = execute(RUN_ENTITY, 'read', () => {
        return connection.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as
          WorkflowRunRow | undefined
      })
      if (!row.ok) {
        return row
      }
      if (row.data === undefined) {
        return { ok: true, data: null }
      }
      return runToDomain(row.data)
    },

    updateRun(id, patch) {
      const sets: string[] = []
      const values: unknown[] = []
      if (patch.status !== undefined) {
        sets.push('status = ?')
        values.push(patch.status)
      }
      if (patch.currentIteration !== undefined) {
        sets.push('current_iteration = ?')
        values.push(patch.currentIteration)
      }
      if (patch.totalIterations !== undefined) {
        sets.push('total_iterations = ?')
        values.push(patch.totalIterations)
      }
      if (patch.criteriaSetId !== undefined) {
        sets.push('criteria_set_id = ?')
        values.push(patch.criteriaSetId)
      }
      if (patch.criteriaIteration !== undefined) {
        sets.push('criteria_iteration = ?')
        values.push(patch.criteriaIteration)
      }
      if (patch.completedAt !== undefined) {
        sets.push('completed_at = ?')
        values.push(patch.completedAt)
      }
      if (sets.length === 0) {
        return repository.getRunById(id)
      }
      values.push(id)
      const updated = execute(RUN_ENTITY, 'update', () => {
        return connection
          .prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`)
          .run(...values).changes
      })
      if (!updated.ok) {
        return updated
      }
      if (updated.data === 0) {
        return { ok: true, data: null }
      }
      return repository.getRunById(id)
    },

    listRunsByTask(taskId, status) {
      const conditions = ['task_id = ?']
      const values: unknown[] = [taskId]
      if (status !== undefined) {
        conditions.push('status = ?')
        values.push(status)
      }
      const rows = execute(RUN_ENTITY, 'listRunsByTask', () => {
        return connection
          .prepare(
            `SELECT * FROM workflow_runs WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
          )
          .all(...values) as WorkflowRunRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, runToDomain)
    },

    listRuns(status) {
      const conditions: string[] = []
      const values: unknown[] = []
      if (status !== undefined) {
        conditions.push('status = ?')
        values.push(status)
      }
      const rows = execute(RUN_ENTITY, 'listRuns', () => {
        return connection
          .prepare(
            `SELECT * FROM workflow_runs${conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC`,
          )
          .all(...values) as WorkflowRunRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, runToDomain)
    },

    createStep(input, now = nowIso()) {
      const inserted = execute(STEP_ENTITY, 'create', () => {
        connection
          .prepare(
            `INSERT INTO workflow_steps (id, workflow_run_id, node_id, node_type, status, iteration, attempt, depends_on_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.workflowRunId,
            input.nodeId,
            input.nodeType,
            input.status ?? 'pending',
            input.iteration ?? 0,
            input.attempt ?? 1,
            input.dependsOn === undefined ? null : JSON.stringify(input.dependsOn),
            now,
          )
      })
      if (!inserted.ok) {
        return inserted
      }
      return requireFound(STEP_ENTITY, repository.getStepById(input.id))
    },

    getStepById(id) {
      const row = execute(STEP_ENTITY, 'read', () => {
        return connection.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(id) as
          WorkflowStepRow | undefined
      })
      if (!row.ok) {
        return row
      }
      if (row.data === undefined) {
        return { ok: true, data: null }
      }
      return stepToDomain(row.data)
    },

    updateStep(id, patch) {
      const sets: string[] = []
      const values: unknown[] = []
      if (patch.status !== undefined) {
        sets.push('status = ?')
        values.push(patch.status)
      }
      if (patch.attempt !== undefined) {
        sets.push('attempt = ?')
        values.push(patch.attempt)
      }
      if (patch.result !== undefined) {
        sets.push('result_json = ?')
        values.push(patch.result === null ? null : encodeJson(patch.result))
      }
      if (patch.startedAt !== undefined) {
        sets.push('started_at = ?')
        values.push(patch.startedAt)
      }
      if (patch.finishedAt !== undefined) {
        sets.push('finished_at = ?')
        values.push(patch.finishedAt)
      }
      if (sets.length === 0) {
        return repository.getStepById(id)
      }
      values.push(id)
      const updated = execute(STEP_ENTITY, 'update', () => {
        return connection
          .prepare(`UPDATE workflow_steps SET ${sets.join(', ')} WHERE id = ?`)
          .run(...values).changes
      })
      if (!updated.ok) {
        return updated
      }
      if (updated.data === 0) {
        return { ok: true, data: null }
      }
      return repository.getStepById(id)
    },

    listSteps(workflowRunId) {
      const rows = execute(STEP_ENTITY, 'listSteps', () => {
        return connection
          .prepare('SELECT * FROM workflow_steps WHERE workflow_run_id = ? ORDER BY created_at ASC')
          .all(workflowRunId) as WorkflowStepRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, stepToDomain)
    },

    deleteRun(id) {
      return execute(RUN_ENTITY, 'delete', () => {
        return connection.prepare('DELETE FROM workflow_runs WHERE id = ?').run(id).changes > 0
      })
    },
  }

  return repository
}
