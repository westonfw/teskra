import type Database from 'better-sqlite3'
import { z } from 'zod'

import type { ArtifactType, IpcResult } from '@teskra/contracts'
import { artifactTypeSchema } from '@teskra/contracts'

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
 * ArtifactRepository (TASK-007) — the `artifacts` table (plan §139.1,
 * 004_artifacts_memory.sql lines 5406–5417). Small content is inlined in
 * `content`; large content lives under run_dir/artifacts/ with `file_path`.
 */

export const artifactRecordSchema = z.strictObject({
  id: z.string(),
  taskId: z.string(),
  runId: z.string().optional(),
  type: artifactTypeSchema,
  name: z.string(),
  content: z.string().optional(),
  filePath: z.string().optional(),
  metadata: jsonRecordSchema.optional(),
  createdAt: isoTimestampSchema,
})
export type Artifact = z.infer<typeof artifactRecordSchema>

interface ArtifactRow {
  id: string
  task_id: string
  run_id: string | null
  type: string
  name: string
  content: string | null
  file_path: string | null
  metadata_json: string | null
  created_at: string
}

export interface CreateArtifactInput {
  readonly id: string
  readonly taskId: string
  readonly type: ArtifactType
  readonly name: string
  readonly runId?: string
  readonly content?: string
  readonly filePath?: string
  readonly metadata?: JsonRecord
}

export interface UpdateArtifactInput {
  readonly name?: string
  readonly content?: string | null
  readonly filePath?: string | null
  readonly metadata?: JsonRecord | null
}

export interface ArtifactRepository {
  create(input: CreateArtifactInput, now?: string): IpcResult<Artifact>
  getById(id: string): IpcResult<Artifact | null>
  update(id: string, patch: UpdateArtifactInput): IpcResult<Artifact | null>
  listByTask(taskId: string, type?: ArtifactType): IpcResult<Artifact[]>
  listByRun(runId: string): IpcResult<Artifact[]>
  delete(id: string): IpcResult<boolean>
}

const ENTITY = 'artifact'

function toDomain(row: ArtifactRow): IpcResult<Artifact> {
  const metadata = decodeJson(jsonRecordSchema, ENTITY, 'metadata_json', row.metadata_json)
  if (!metadata.ok) {
    return metadata
  }
  return validateRow(artifactRecordSchema, ENTITY, {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id ?? undefined,
    type: row.type,
    name: row.name,
    content: row.content ?? undefined,
    filePath: row.file_path ?? undefined,
    metadata: metadata.data,
    createdAt: row.created_at,
  })
}

export function createArtifactRepository(connection: Database.Database): ArtifactRepository {
  const repository: ArtifactRepository = {
    create(input, now = nowIso()) {
      const inserted = execute(ENTITY, 'create', () => {
        connection
          .prepare(
            `INSERT INTO artifacts (id, task_id, run_id, type, name, content, file_path, metadata_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.taskId,
            input.runId ?? null,
            input.type,
            input.name,
            input.content ?? null,
            input.filePath ?? null,
            encodeJson(input.metadata),
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
        return connection.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
          ArtifactRow | undefined
      })
      if (!row.ok) {
        return row
      }
      if (row.data === undefined) {
        return { ok: true, data: null }
      }
      return toDomain(row.data)
    },

    update(id, patch) {
      const sets: string[] = []
      const values: unknown[] = []
      if (patch.name !== undefined) {
        sets.push('name = ?')
        values.push(patch.name)
      }
      if (patch.content !== undefined) {
        sets.push('content = ?')
        values.push(patch.content)
      }
      if (patch.filePath !== undefined) {
        sets.push('file_path = ?')
        values.push(patch.filePath)
      }
      if (patch.metadata !== undefined) {
        sets.push('metadata_json = ?')
        values.push(patch.metadata === null ? null : encodeJson(patch.metadata))
      }
      if (sets.length === 0) {
        return repository.getById(id)
      }
      values.push(id)
      const updated = execute(ENTITY, 'update', () => {
        return connection
          .prepare(`UPDATE artifacts SET ${sets.join(', ')} WHERE id = ?`)
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

    listByTask(taskId, type) {
      const conditions = ['task_id = ?']
      const values: unknown[] = [taskId]
      if (type !== undefined) {
        conditions.push('type = ?')
        values.push(type)
      }
      const rows = execute(ENTITY, 'listByTask', () => {
        return connection
          .prepare(
            `SELECT * FROM artifacts WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`,
          )
          .all(...values) as ArtifactRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toDomain)
    },

    listByRun(runId) {
      const rows = execute(ENTITY, 'listByRun', () => {
        return connection
          .prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC')
          .all(runId) as ArtifactRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toDomain)
    },

    delete(id) {
      return execute(ENTITY, 'delete', () => {
        return connection.prepare('DELETE FROM artifacts WHERE id = ?').run(id).changes > 0
      })
    },
  }

  return repository
}
