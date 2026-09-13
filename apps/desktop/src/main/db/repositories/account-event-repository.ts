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
  requireFound,
  validateRow,
  type JsonRecord,
} from './common'

/**
 * AccountEventRepository (TASK-116, Milestone 24 §8.1.1/§41) — the
 * `account_events` table (migration 012). The audit trail of the account
 * lifecycle: profile CRUD / login / status transitions plus the Run-related
 * account events (profile selection, rate limits, continuations, account
 * switches).
 *
 * The two existing event tables cannot hold these rows: `permission_audit`
 * and `agent_events` both have `run_id NOT NULL REFERENCES agent_runs(id)`,
 * while `account.created` / `account.login_started` belong to no Run. Here
 * BOTH `profile_id` and `run_id` are nullable and deliberately carry no FK:
 * a hard-deleted profile must leave its audit trail behind (§8.1.1), and a
 * `run_id` value is a weak reference, never enforced.
 */

/**
 * §41 event names. `event_type` itself stays a free-form string (same as
 * `agent_events`) — this list is the canonical vocabulary for writers and
 * tests, not a Zod enum.
 */
export const ACCOUNT_EVENT_TYPES = [
  'account.created',
  'account.updated',
  'account.login_started',
  'account.login_verified',
  'account.status_changed',
  'agent.profile_selected',
  'agent.rate_limited',
  'agent.continuation_created',
  'agent.account_switched',
] as const
export type AccountEventType = (typeof ACCOUNT_EVENT_TYPES)[number]

export const accountEventRecordSchema = z.strictObject({
  id: z.number().int(),
  profileId: z.string().optional(),
  runId: z.string().optional(),
  eventType: z.string(),
  payload: jsonRecordSchema,
  createdAt: isoTimestampSchema,
})
export type AccountEvent = z.infer<typeof accountEventRecordSchema>

interface AccountEventRow {
  id: number
  profile_id: string | null
  run_id: string | null
  event_type: string
  payload_json: string
  created_at: string
}

export interface AppendAccountEventInput {
  readonly profileId?: string | undefined
  readonly runId?: string | undefined
  readonly eventType: string
  readonly payload: JsonRecord
}

export interface AccountEventListFilter {
  /** Defaults to 500 (same convention as the permission audit listing). */
  readonly limit?: number | undefined
}

export interface AccountEventRepository {
  append(input: AppendAccountEventInput, now?: string): IpcResult<AccountEvent>
  /** Newest first, bounded by filter.limit. */
  listByProfile(profileId: string, filter?: AccountEventListFilter): IpcResult<AccountEvent[]>
  /** Newest first, bounded by filter.limit. */
  listByType(eventType: string, filter?: AccountEventListFilter): IpcResult<AccountEvent[]>
}

const ENTITY = 'account-event'
const DEFAULT_LIST_LIMIT = 500

function toDomain(row: AccountEventRow): IpcResult<AccountEvent> {
  // payload_json is NOT NULL; a missing payload is corrupted data, not "no payload".
  const payload = decodeJson(jsonRecordSchema, ENTITY, 'payload_json', row.payload_json)
  if (!payload.ok) {
    return payload
  }
  return validateRow(accountEventRecordSchema, ENTITY, {
    id: row.id,
    profileId: row.profile_id ?? undefined,
    runId: row.run_id ?? undefined,
    eventType: row.event_type,
    payload: payload.data,
    createdAt: row.created_at,
  })
}

export function createAccountEventRepository(
  connection: Database.Database,
): AccountEventRepository {
  const insertStatement = connection.prepare(
    `INSERT INTO account_events (profile_id, run_id, event_type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const selectByIdStatement = connection.prepare('SELECT * FROM account_events WHERE id = ?')
  const listByProfileStatement = connection.prepare(
    'SELECT * FROM account_events WHERE profile_id = ? ORDER BY id DESC LIMIT ?',
  )
  const listByTypeStatement = connection.prepare(
    'SELECT * FROM account_events WHERE event_type = ? ORDER BY id DESC LIMIT ?',
  )

  const readById = (id: number): IpcResult<AccountEvent | null> => {
    const row = execute(
      ENTITY,
      'read',
      () => selectByIdStatement.get(id) as AccountEventRow | undefined,
    )
    if (!row.ok) {
      return row
    }
    if (row.data === undefined) {
      return { ok: true, data: null }
    }
    return toDomain(row.data)
  }

  return {
    append(input, now = nowIso()) {
      const inserted = execute(ENTITY, 'append', () => {
        const result = insertStatement.run(
          input.profileId ?? null,
          input.runId ?? null,
          input.eventType,
          encodeJson(input.payload),
          now,
        )
        return Number(result.lastInsertRowid)
      })
      if (!inserted.ok) {
        return inserted
      }
      return requireFound(ENTITY, readById(inserted.data))
    },

    listByProfile(profileId, filter = {}) {
      const rows = execute(
        ENTITY,
        'listByProfile',
        () =>
          listByProfileStatement.all(
            profileId,
            filter.limit ?? DEFAULT_LIST_LIMIT,
          ) as AccountEventRow[],
      )
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toDomain)
    },

    listByType(eventType, filter = {}) {
      const rows = execute(
        ENTITY,
        'listByType',
        () =>
          listByTypeStatement.all(
            eventType,
            filter.limit ?? DEFAULT_LIST_LIMIT,
          ) as AccountEventRow[],
      )
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toDomain)
    },
  }
}
