import type Database from 'better-sqlite3'
import { z } from 'zod'

import type { IpcResult, Workspace, WorkspaceRuntimeRef } from '@teskra/contracts'
import { workspaceRuntimeRefSchema } from '@teskra/contracts'

import {
  decodeJson,
  encodeJson,
  execute,
  isoTimestampSchema,
  mapRows,
  nowIso,
  requireFound,
  validateRow,
} from './common'

/**
 * WorkspaceRepository (TASK-007) — the `workspaces` table (plan §139.1,
 * 001_init.sql lines 5196–5213).
 *
 * Owns the WorkspaceRuntimeRef flatten/restore duty: the DB stores the ref
 * as flat columns (runtime_kind / wsl_distro / ssh_host / container_id)
 * while the domain object (contracts `Workspace`) nests it as `runtime`.
 */

/**
 * Read-side schema: identical shape to contracts `workspaceSchema`, but with
 * ISO-8601 UTC format validation on the timestamp columns (acceptance:
 * "时间统一使用 ISO UTC，有测试断言格式").
 */
const workspaceRowSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  runtime: workspaceRuntimeRefSchema,
  path: z.string(),
  gitRoot: z.string().optional(),
  defaultBranch: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  lastOpenedAt: isoTimestampSchema.optional(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
})

interface WorkspaceRow {
  id: string
  name: string
  runtime_kind: string
  wsl_distro: string | null
  ssh_host: string | null
  container_id: string | null
  path: string
  git_root: string | null
  default_branch: string | null
  env_json: string | null
  last_opened_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateWorkspaceInput {
  readonly id: string
  readonly name: string
  readonly runtime: WorkspaceRuntimeRef
  readonly path: string
  readonly gitRoot?: string
  readonly defaultBranch?: string
  readonly env?: Record<string, string>
}

/** `null` clears a nullable column; `undefined` leaves it untouched. */
export interface UpdateWorkspaceInput {
  readonly name?: string
  readonly runtime?: WorkspaceRuntimeRef
  readonly path?: string
  readonly gitRoot?: string | null
  readonly defaultBranch?: string | null
  readonly env?: Record<string, string> | null
  readonly lastOpenedAt?: string | null
}

export interface WorkspaceRepository {
  create(input: CreateWorkspaceInput, now?: string): IpcResult<Workspace>
  getById(id: string): IpcResult<Workspace | null>
  update(id: string, patch: UpdateWorkspaceInput, now?: string): IpcResult<Workspace | null>
  list(): IpcResult<Workspace[]>
  /** Most recently opened first; never-opened workspaces last. */
  listRecent(limit: number): IpcResult<Workspace[]>
  delete(id: string): IpcResult<boolean>
}

const ENTITY = 'workspace'

function toDomain(row: WorkspaceRow): IpcResult<Workspace> {
  const env = decodeJson(z.record(z.string(), z.string()), ENTITY, 'env_json', row.env_json)
  if (!env.ok) {
    return env
  }
  return validateRow(workspaceRowSchema, ENTITY, {
    id: row.id,
    name: row.name,
    runtime: {
      kind: row.runtime_kind,
      distro: row.wsl_distro ?? undefined,
      host: row.ssh_host ?? undefined,
      containerId: row.container_id ?? undefined,
    },
    path: row.path,
    gitRoot: row.git_root ?? undefined,
    defaultBranch: row.default_branch ?? undefined,
    env: env.data,
    lastOpenedAt: row.last_opened_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export function createWorkspaceRepository(connection: Database.Database): WorkspaceRepository {
  const getRow = (id: string): WorkspaceRow | undefined =>
    connection.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined

  const repository: WorkspaceRepository = {
    create(input, now = nowIso()) {
      const inserted = execute(ENTITY, 'create', () => {
        connection
          .prepare(
            `INSERT INTO workspaces (id, name, runtime_kind, wsl_distro, ssh_host, container_id, path, git_root, default_branch, env_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.name,
            input.runtime.kind,
            input.runtime.distro ?? null,
            input.runtime.host ?? null,
            input.runtime.containerId ?? null,
            input.path,
            input.gitRoot ?? null,
            input.defaultBranch ?? null,
            encodeJson(input.env),
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
      const row = execute(ENTITY, 'read', () => getRow(id))
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
      if (patch.name !== undefined) {
        sets.push('name = ?')
        values.push(patch.name)
      }
      if (patch.runtime !== undefined) {
        sets.push('runtime_kind = ?', 'wsl_distro = ?', 'ssh_host = ?', 'container_id = ?')
        values.push(
          patch.runtime.kind,
          patch.runtime.distro ?? null,
          patch.runtime.host ?? null,
          patch.runtime.containerId ?? null,
        )
      }
      if (patch.path !== undefined) {
        sets.push('path = ?')
        values.push(patch.path)
      }
      if (patch.gitRoot !== undefined) {
        sets.push('git_root = ?')
        values.push(patch.gitRoot)
      }
      if (patch.defaultBranch !== undefined) {
        sets.push('default_branch = ?')
        values.push(patch.defaultBranch)
      }
      if (patch.env !== undefined) {
        sets.push('env_json = ?')
        values.push(patch.env === null ? null : encodeJson(patch.env))
      }
      if (patch.lastOpenedAt !== undefined) {
        sets.push('last_opened_at = ?')
        values.push(patch.lastOpenedAt)
      }
      if (sets.length === 0) {
        return repository.getById(id)
      }
      sets.push('updated_at = ?')
      values.push(now, id)
      const updated = execute(ENTITY, 'update', () => {
        return connection
          .prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`)
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

    list() {
      const rows = execute(ENTITY, 'list', () => {
        return connection
          .prepare('SELECT * FROM workspaces ORDER BY created_at DESC')
          .all() as WorkspaceRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toDomain)
    },

    listRecent(limit) {
      const rows = execute(ENTITY, 'listRecent', () => {
        return connection
          .prepare(
            `SELECT * FROM workspaces
             ORDER BY last_opened_at IS NULL, last_opened_at DESC, created_at DESC
             LIMIT ?`,
          )
          .all(limit) as WorkspaceRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toDomain)
    },

    delete(id) {
      return execute(ENTITY, 'delete', () => {
        return connection.prepare('DELETE FROM workspaces WHERE id = ?').run(id).changes > 0
      })
    },
  }

  return repository
}
