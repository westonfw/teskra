import type Database from 'better-sqlite3'
import { z } from 'zod'

import type { HandoffParseStatus, HandoffType, IpcResult, WorkerHandoff } from '@teskra/contracts'
import { handoffParseStatusSchema, handoffTypeSchema, workerHandoffSchema } from '@teskra/contracts'

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
 * HandoffRepository (TASK-007) — the `handoffs` table (plan §139.1,
 * 004_artifacts_memory.sql lines 5419–5429), one row per run
 * (idx_handoffs_run UNIQUE).
 *
 * ADR-0004 file contract: when `parse_status` is 'ok' the payload is a full
 * contracts `WorkerHandoff` and is validated as such on read; for
 * 'degraded' / 'missing' the payload (if any) is a partial parse result and
 * is only validated as a JSON object. Corrupted JSON surfaces as
 * VALIDATION_FAILED, never a raw throw.
 */

export const handoffRecordSchema = z.strictObject({
  id: z.string(),
  runId: z.string(),
  type: handoffTypeSchema,
  /** Full WorkerHandoff when parseStatus is 'ok'; partial record otherwise. */
  payload: jsonRecordSchema.optional(),
  rawPath: z.string().optional(),
  parseStatus: handoffParseStatusSchema,
  createdAt: isoTimestampSchema,
})
export type Handoff = z.infer<typeof handoffRecordSchema>

interface HandoffRow {
  id: string
  run_id: string
  type: string
  payload_json: string | null
  raw_path: string | null
  parse_status: string
  created_at: string
}

export interface SaveHandoffInput {
  readonly id: string
  readonly runId: string
  readonly type: HandoffType
  readonly payload?: WorkerHandoff | JsonRecord
  readonly rawPath?: string
  readonly parseStatus: HandoffParseStatus
}

export interface HandoffRepository {
  /** Inserts, or replaces the existing row for the run (run_id is unique). */
  save(input: SaveHandoffInput, now?: string): IpcResult<Handoff>
  getById(id: string): IpcResult<Handoff | null>
  getByRunId(runId: string): IpcResult<Handoff | null>
  /**
   * TASK-138: batch read for the thread projection — the handoff rows of
   * every run of a task in one query, oldest first. An empty id list
   * short-circuits to an empty result.
   */
  listByRuns(runIds: readonly string[]): IpcResult<Handoff[]>
  delete(id: string): IpcResult<boolean>
}

const ENTITY = 'handoff'

function toDomain(row: HandoffRow): IpcResult<Handoff> {
  const payloadSchema = row.parse_status === 'ok' ? workerHandoffSchema : jsonRecordSchema
  const payload = decodeJson(payloadSchema, ENTITY, 'payload_json', row.payload_json)
  if (!payload.ok) {
    return payload
  }
  return validateRow(handoffRecordSchema, ENTITY, {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    payload: payload.data,
    rawPath: row.raw_path ?? undefined,
    parseStatus: row.parse_status,
    createdAt: row.created_at,
  })
}

export function createHandoffRepository(connection: Database.Database): HandoffRepository {
  const repository: HandoffRepository = {
    save(input, now = nowIso()) {
      const saved = execute(ENTITY, 'save', () => {
        connection
          .prepare(
            `INSERT INTO handoffs (id, run_id, type, payload_json, raw_path, parse_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (run_id)
             DO UPDATE SET id = excluded.id, type = excluded.type,
                           payload_json = excluded.payload_json, raw_path = excluded.raw_path,
                           parse_status = excluded.parse_status`,
          )
          .run(
            input.id,
            input.runId,
            input.type,
            encodeJson(input.payload),
            input.rawPath ?? null,
            input.parseStatus,
            now,
          )
      })
      if (!saved.ok) {
        return saved
      }
      return requireFound(ENTITY, repository.getByRunId(input.runId))
    },

    getById(id) {
      const row = execute(ENTITY, 'read', () => {
        return connection.prepare('SELECT * FROM handoffs WHERE id = ?').get(id) as
          HandoffRow | undefined
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
        return connection.prepare('SELECT * FROM handoffs WHERE run_id = ?').get(runId) as
          HandoffRow | undefined
      })
      if (!row.ok) {
        return row
      }
      if (row.data === undefined) {
        return { ok: true, data: null }
      }
      return toDomain(row.data)
    },

    delete(id) {
      return execute(ENTITY, 'delete', () => {
        return connection.prepare('DELETE FROM handoffs WHERE id = ?').run(id).changes > 0
      })
    },

    listByRuns(runIds) {
      if (runIds.length === 0) {
        return { ok: true, data: [] }
      }
      const rows = execute(ENTITY, 'listByRuns', () => {
        const placeholders = runIds.map(() => '?').join(', ')
        return connection
          .prepare(
            `SELECT * FROM handoffs WHERE run_id IN (${placeholders}) ORDER BY created_at ASC`,
          )
          .all(...runIds) as HandoffRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toDomain)
    },
  }

  return repository
}
