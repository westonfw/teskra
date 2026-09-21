import type Database from 'better-sqlite3'
import { z } from 'zod'

import type { IpcResult } from '@teskra/contracts'

import {
  decodeJson,
  encodeJson,
  execute,
  isoTimestampSchema,
  jsonRecordSchema,
  mapRows,
  nowIso,
  validateRow,
  type JsonRecord,
} from './common'

/**
 * AgentEventRepository (TASK-007) — the `agent_events` table (plan §139.1,
 * 002_runs.sql lines 5319–5327). Events are append-only per run; `seq`
 * aligns with the events.jsonl line number and (run_id, seq) is unique.
 */

export const agentEventRecordSchema = z.strictObject({
  id: z.number().int(),
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  eventType: z.string(),
  payload: jsonRecordSchema,
  createdAt: isoTimestampSchema,
})
export type AgentEvent = z.infer<typeof agentEventRecordSchema>

interface AgentEventRow {
  id: number
  run_id: string
  seq: number
  event_type: string
  payload_json: string
  created_at: string
}

export interface AppendAgentEventInput {
  readonly runId: string
  readonly seq: number
  readonly eventType: string
  readonly payload: JsonRecord
}

export interface AgentEventRepository {
  append(input: AppendAgentEventInput, now?: string): IpcResult<AgentEvent>
  /** Ordered by seq ascending — the canonical replay order. */
  listByRun(runId: string): IpcResult<AgentEvent[]>
  /**
   * TASK-126: one event type of a run, paged by seq (`afterSeq` exclusive,
   * ordered ascending). Powers `teskra:agent:list-progress`.
   */
  listByRunAndType(
    runId: string,
    eventType: string,
    options?: { afterSeq?: number; limit?: number },
  ): IpcResult<AgentEvent[]>
  /** Next free seq for a run (MAX(seq) + 1, starting at 1). */
  nextSeq(runId: string): IpcResult<number>
}

const ENTITY = 'agent-event'

function toDomain(row: AgentEventRow): IpcResult<AgentEvent> {
  // payload_json is NOT NULL; a missing payload is corrupted data, not "no payload".
  const payload = decodeJson(jsonRecordSchema, ENTITY, 'payload_json', row.payload_json)
  if (!payload.ok) {
    return payload
  }
  return validateRow(agentEventRecordSchema, ENTITY, {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    eventType: row.event_type,
    payload: payload.data,
    createdAt: row.created_at,
  })
}

export function createAgentEventRepository(connection: Database.Database): AgentEventRepository {
  // P1-1: statements are prepared once per repository — agent.output events
  // make `append` the hottest write path in the app, and re-preparing the
  // same SQL per call dominated it.
  const insertStatement = connection.prepare(
    `INSERT INTO agent_events (run_id, seq, event_type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const selectByIdStatement = connection.prepare('SELECT * FROM agent_events WHERE id = ?')
  const listByRunStatement = connection.prepare(
    'SELECT * FROM agent_events WHERE run_id = ? ORDER BY seq ASC',
  )
  const listByRunAndTypeStatement = connection.prepare(
    'SELECT * FROM agent_events WHERE run_id = ? AND event_type = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
  )
  const maxSeqStatement = connection.prepare(
    'SELECT MAX(seq) AS max_seq FROM agent_events WHERE run_id = ?',
  )

  return {
    append(input, now = nowIso()) {
      const inserted = execute(ENTITY, 'append', () => {
        const result = insertStatement.run(
          input.runId,
          input.seq,
          input.eventType,
          encodeJson(input.payload),
          now,
        )
        return Number(result.lastInsertRowid)
      })
      if (!inserted.ok) {
        return inserted
      }
      const row = execute(ENTITY, 'read', () => {
        return selectByIdStatement.get(inserted.data) as AgentEventRow
      })
      if (!row.ok) {
        return row
      }
      return toDomain(row.data)
    },

    listByRun(runId) {
      const rows = execute(ENTITY, 'listByRun', () => {
        return listByRunStatement.all(runId) as AgentEventRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toDomain)
    },

    listByRunAndType(runId, eventType, options = {}) {
      const rows = execute(ENTITY, 'listByRunAndType', () => {
        return listByRunAndTypeStatement.all(
          runId,
          eventType,
          options.afterSeq ?? 0,
          // SQLite LIMIT rejects non-positive values for our purposes; an
          // absent limit means "the rest of the run's events of this type".
          options.limit ?? -1,
        ) as AgentEventRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toDomain)
    },

    nextSeq(runId) {
      return execute(ENTITY, 'nextSeq', () => {
        const row = maxSeqStatement.get(runId) as { max_seq: number | null }
        return (row.max_seq ?? 0) + 1
      })
    },
  }
}
