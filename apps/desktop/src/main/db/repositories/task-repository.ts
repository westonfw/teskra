import type Database from 'better-sqlite3'
import { z } from 'zod'

import type { IpcResult, Task, TaskStatus } from '@teskra/contracts'
import { taskStatusSchema } from '@teskra/contracts'

import { execute, isoTimestampSchema, mapRows, nowIso, requireFound, validateRow } from './common'

/**
 * TaskRepository (TASK-007) — the `tasks` table (plan §139.1, 001_init.sql
 * lines 5215–5226). Status uses the contracts `TaskStatus` 八态 enum.
 */

const taskRowSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: taskStatusSchema,
  archivedAt: isoTimestampSchema.optional(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
})

interface TaskRow {
  id: string
  workspace_id: string
  title: string
  description: string | null
  status: string
  archived_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateTaskInput {
  readonly id: string
  readonly workspaceId: string
  readonly title: string
  readonly description?: string
  /** Defaults to 'draft'. */
  readonly status?: TaskStatus
}

export interface UpdateTaskInput {
  readonly title?: string
  readonly description?: string | null
  readonly status?: TaskStatus
  readonly archivedAt?: string | null
}

export interface ListTasksFilter {
  readonly status?: TaskStatus
  /** Default false: archived tasks are hidden. */
  readonly includeArchived?: boolean
}

export interface TaskRepository {
  create(input: CreateTaskInput, now?: string): IpcResult<Task>
  getById(id: string): IpcResult<Task | null>
  update(id: string, patch: UpdateTaskInput, now?: string): IpcResult<Task | null>
  updateStatus(id: string, status: TaskStatus, now?: string): IpcResult<Task | null>
  listByWorkspace(workspaceId: string, filter?: ListTasksFilter): IpcResult<Task[]>
  delete(id: string): IpcResult<boolean>
}

const ENTITY = 'task'

function toDomain(row: TaskRow): IpcResult<Task> {
  return validateRow(taskRowSchema, ENTITY, {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export function createTaskRepository(connection: Database.Database): TaskRepository {
  const repository: TaskRepository = {
    create(input, now = nowIso()) {
      const inserted = execute(ENTITY, 'create', () => {
        connection
          .prepare(
            `INSERT INTO tasks (id, workspace_id, title, description, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.workspaceId,
            input.title,
            input.description ?? null,
            input.status ?? 'draft',
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
        return connection.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
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
      const sets: string[] = []
      const values: unknown[] = []
      if (patch.title !== undefined) {
        sets.push('title = ?')
        values.push(patch.title)
      }
      if (patch.description !== undefined) {
        sets.push('description = ?')
        values.push(patch.description)
      }
      if (patch.status !== undefined) {
        sets.push('status = ?')
        values.push(patch.status)
      }
      if (patch.archivedAt !== undefined) {
        sets.push('archived_at = ?')
        values.push(patch.archivedAt)
      }
      if (sets.length === 0) {
        return repository.getById(id)
      }
      sets.push('updated_at = ?')
      values.push(now, id)
      const updated = execute(ENTITY, 'update', () => {
        return connection.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
          .changes
      })
      if (!updated.ok) {
        return updated
      }
      if (updated.data === 0) {
        return { ok: true, data: null }
      }
      return repository.getById(id)
    },

    updateStatus(id, status, now) {
      return repository.update(id, { status }, now)
    },

    listByWorkspace(workspaceId, filter = {}) {
      const conditions = ['workspace_id = ?']
      const values: unknown[] = [workspaceId]
      if (filter.status !== undefined) {
        conditions.push('status = ?')
        values.push(filter.status)
      }
      if (!filter.includeArchived) {
        conditions.push('archived_at IS NULL')
      }
      const rows = execute(ENTITY, 'listByWorkspace', () => {
        return connection
          .prepare(`SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`)
          .all(...values) as TaskRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toDomain)
    },

    delete(id) {
      return execute(ENTITY, 'delete', () => {
        return connection.transaction(() => {
          const deleted =
            connection.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0
          // ADR-0007: deleting the task NULLs its criteria sets' task_id
          // (migration 010). Sets still anchored by audit rows (runs /
          // workflow runs / panels / findings) stay so the acceptance
          // contract a run was judged against remains traceable; everything
          // else orphaned by the delete is swept here.
          connection
            .prepare(
              `DELETE FROM acceptance_criteria_sets
               WHERE task_id IS NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM agent_runs
                   WHERE agent_runs.criteria_set_id = acceptance_criteria_sets.id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM workflow_runs
                   WHERE workflow_runs.criteria_set_id = acceptance_criteria_sets.id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM review_panels
                   WHERE review_panels.criteria_set_id = acceptance_criteria_sets.id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM review_findings
                   JOIN acceptance_criteria
                     ON acceptance_criteria.id = review_findings.criterion_id
                   WHERE acceptance_criteria.criteria_set_id = acceptance_criteria_sets.id
                 )`,
            )
            .run()
          return deleted
        })()
      })
    },
  }

  return repository
}
