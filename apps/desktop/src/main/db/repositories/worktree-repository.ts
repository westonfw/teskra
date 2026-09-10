import type Database from 'better-sqlite3'
import { z } from 'zod'

import type { IpcResult, WorktreeIsolation, WorktreeState } from '@teskra/contracts'
import { worktreeIsolationSchema, worktreeStateSchema } from '@teskra/contracts'

import { execute, isoTimestampSchema, mapRows, nowIso, requireFound, validateRow } from './common'

/**
 * WorktreeRepository (TASK-007) — the `worktrees` table (plan §139.1,
 * 002_runs.sql lines 5232–5247).
 *
 * `run_id` is the redundant reverse pointer of `agent_runs.worktree_id`
 * (deliberately no FK — see §139.1 "循环引用的处理"); consistency across the
 * two columns is maintained by callers within one transaction and checked by
 * Doctor (TASK-041).
 */

export const worktreeRecordSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  runId: z.string().optional(),
  branch: z.string(),
  baseBranch: z.string(),
  path: z.string(),
  state: worktreeStateSchema,
  isolation: worktreeIsolationSchema,
  mergedAt: isoTimestampSchema.optional(),
  discardedAt: isoTimestampSchema.optional(),
  archivedAt: isoTimestampSchema.optional(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
})
export type Worktree = z.infer<typeof worktreeRecordSchema>

interface WorktreeRow {
  id: string
  workspace_id: string
  run_id: string | null
  branch: string
  base_branch: string
  path: string
  state: string
  isolation: string
  merged_at: string | null
  discarded_at: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateWorktreeInput {
  readonly id: string
  readonly workspaceId: string
  readonly branch: string
  readonly baseBranch: string
  readonly path: string
  readonly isolation: WorktreeIsolation
  readonly runId?: string
  /** Defaults to 'creating'. */
  readonly state?: WorktreeState
}

export interface UpdateWorktreeInput {
  readonly runId?: string | null
  readonly branch?: string
  readonly path?: string
  readonly state?: WorktreeState
  readonly mergedAt?: string | null
  readonly discardedAt?: string | null
  readonly archivedAt?: string | null
}

export interface WorktreeRepository {
  create(input: CreateWorktreeInput, now?: string): IpcResult<Worktree>
  getById(id: string): IpcResult<Worktree | null>
  /** Reverse lookup through the redundant `run_id` pointer. */
  getByRunId(runId: string): IpcResult<Worktree | null>
  update(id: string, patch: UpdateWorktreeInput, now?: string): IpcResult<Worktree | null>
  updateState(id: string, state: WorktreeState, now?: string): IpcResult<Worktree | null>
  /** Archived worktrees (TASK-047) are hidden unless `includeArchived` is true. */
  listByWorkspace(
    workspaceId: string,
    state?: WorktreeState,
    includeArchived?: boolean,
  ): IpcResult<Worktree[]>
  delete(id: string): IpcResult<boolean>
}

const ENTITY = 'worktree'

function toDomain(row: WorktreeRow): IpcResult<Worktree> {
  return validateRow(worktreeRecordSchema, ENTITY, {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id ?? undefined,
    branch: row.branch,
    baseBranch: row.base_branch,
    path: row.path,
    state: row.state,
    isolation: row.isolation,
    mergedAt: row.merged_at ?? undefined,
    discardedAt: row.discarded_at ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export function createWorktreeRepository(connection: Database.Database): WorktreeRepository {
  const repository: WorktreeRepository = {
    create(input, now = nowIso()) {
      const inserted = execute(ENTITY, 'create', () => {
        connection
          .prepare(
            `INSERT INTO worktrees (id, workspace_id, run_id, branch, base_branch, path, state, isolation, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.workspaceId,
            input.runId ?? null,
            input.branch,
            input.baseBranch,
            input.path,
            input.state ?? 'creating',
            input.isolation,
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
        return connection.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as
          WorktreeRow | undefined
      })
      if (!row.ok) {
        return row
      }
      if (row.data === undefined) {
        return { ok: true, data: null }
      }
      return toDomain(row.data)
    },

    getByRunId(runId) {
      const row = execute(ENTITY, 'getByRunId', () => {
        return connection.prepare('SELECT * FROM worktrees WHERE run_id = ?').get(runId) as
          WorktreeRow | undefined
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
      if (patch.runId !== undefined) {
        sets.push('run_id = ?')
        values.push(patch.runId)
      }
      if (patch.branch !== undefined) {
        sets.push('branch = ?')
        values.push(patch.branch)
      }
      if (patch.path !== undefined) {
        sets.push('path = ?')
        values.push(patch.path)
      }
      if (patch.state !== undefined) {
        sets.push('state = ?')
        values.push(patch.state)
      }
      if (patch.mergedAt !== undefined) {
        sets.push('merged_at = ?')
        values.push(patch.mergedAt)
      }
      if (patch.discardedAt !== undefined) {
        sets.push('discarded_at = ?')
        values.push(patch.discardedAt)
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
        return connection
          .prepare(`UPDATE worktrees SET ${sets.join(', ')} WHERE id = ?`)
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

    updateState(id, state, now) {
      return repository.update(id, { state }, now)
    },

    listByWorkspace(workspaceId, state, includeArchived = false) {
      const conditions = ['workspace_id = ?']
      const values: unknown[] = [workspaceId]
      if (state !== undefined) {
        conditions.push('state = ?')
        values.push(state)
      }
      if (!includeArchived) {
        conditions.push('archived_at IS NULL')
      }
      const rows = execute(ENTITY, 'listByWorkspace', () => {
        return connection
          .prepare(
            `SELECT * FROM worktrees WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
          )
          .all(...values) as WorktreeRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toDomain)
    },

    delete(id) {
      return execute(ENTITY, 'delete', () => {
        return connection.prepare('DELETE FROM worktrees WHERE id = ?').run(id).changes > 0
      })
    },
  }

  return repository
}
