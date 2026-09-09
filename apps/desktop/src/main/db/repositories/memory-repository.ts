import type Database from 'better-sqlite3'
import { z } from 'zod'

import type { IpcResult, MemoryType } from '@teskra/contracts'
import { memoryTypeSchema } from '@teskra/contracts'

import { execute, isoTimestampSchema, mapRows, nowIso, requireFound, validateRow } from './common'

/**
 * MemoryRepository (TASK-007) — the `memories` table (plan §139.1,
 * 004_artifacts_memory.sql lines 5431–5440). `source` is
 * 'manual' | 'file:<path>' | 'run:<runId>' — free-form by design.
 */

export const memoryRecordSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  type: memoryTypeSchema,
  content: z.string(),
  source: z.string().optional(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
})
export type Memory = z.infer<typeof memoryRecordSchema>

interface MemoryRow {
  id: string
  workspace_id: string
  type: string
  content: string
  source: string | null
  created_at: string
  updated_at: string
}

export interface CreateMemoryInput {
  readonly id: string
  readonly workspaceId: string
  readonly type: MemoryType
  readonly content: string
  readonly source?: string
}

export interface UpdateMemoryInput {
  readonly type?: MemoryType
  readonly content?: string
  readonly source?: string | null
}

export interface MemoryRepository {
  create(input: CreateMemoryInput, now?: string): IpcResult<Memory>
  getById(id: string): IpcResult<Memory | null>
  update(id: string, patch: UpdateMemoryInput, now?: string): IpcResult<Memory | null>
  listByWorkspace(workspaceId: string, type?: MemoryType): IpcResult<Memory[]>
  delete(id: string): IpcResult<boolean>
}

const ENTITY = 'memory'

function toDomain(row: MemoryRow): IpcResult<Memory> {
  return validateRow(memoryRecordSchema, ENTITY, {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    content: row.content,
    source: row.source ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export function createMemoryRepository(connection: Database.Database): MemoryRepository {
  const repository: MemoryRepository = {
    create(input, now = nowIso()) {
      const inserted = execute(ENTITY, 'create', () => {
        connection
          .prepare(
            `INSERT INTO memories (id, workspace_id, type, content, source, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.workspaceId,
            input.type,
            input.content,
            input.source ?? null,
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
        return connection.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
          MemoryRow | undefined
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
      if (patch.type !== undefined) {
        sets.push('type = ?')
        values.push(patch.type)
      }
      if (patch.content !== undefined) {
        sets.push('content = ?')
        values.push(patch.content)
      }
      if (patch.source !== undefined) {
        sets.push('source = ?')
        values.push(patch.source)
      }
      if (sets.length === 0) {
        return repository.getById(id)
      }
      sets.push('updated_at = ?')
      values.push(now, id)
      const updated = execute(ENTITY, 'update', () => {
        return connection
          .prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`)
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

    listByWorkspace(workspaceId, type) {
      const conditions = ['workspace_id = ?']
      const values: unknown[] = [workspaceId]
      if (type !== undefined) {
        conditions.push('type = ?')
        values.push(type)
      }
      const rows = execute(ENTITY, 'listByWorkspace', () => {
        return connection
          .prepare(
            `SELECT * FROM memories WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`,
          )
          .all(...values) as MemoryRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toDomain)
    },

    delete(id) {
      return execute(ENTITY, 'delete', () => {
        return connection.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0
      })
    },
  }

  return repository
}
