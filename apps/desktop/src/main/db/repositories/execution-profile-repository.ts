import type Database from 'better-sqlite3'

import type { AgentExecutionProfile, ApprovalMode, IpcResult } from '@teskra/contracts'
import { agentExecutionProfileSchema } from '@teskra/contracts'

import { execute, mapRows, nowIso, requireFound, validateRow } from './common'

/**
 * ExecutionProfileRepository (TASK-110, Milestone 24 §8.2) — the
 * `agent_execution_profiles` table (migration 014).
 *
 * Row ↔ domain mapping is flat: every nullable column maps to `undefined`.
 * The per-agent default is NOT stored here — it lives in the global config
 * layer (`agents.defaultExecutionProfiles`), same pattern as account
 * profiles (§15), so this repository has no setDefault.
 *
 * Removal is a real DELETE (execution profiles have no enabled/soft-disable
 * concept — that lifecycle is account-only, §47.1). Nothing references
 * execution profiles by FK (agent_runs.execution_profile_id is a deliberate
 * weak reference, migration 013), so a delete cannot cascade.
 */

export const executionProfileRecordSchema = agentExecutionProfileSchema
export type { AgentExecutionProfile } from '@teskra/contracts'

interface ExecutionProfileRow {
  id: string
  name: string
  agent_id: string
  account_profile_id: string | null
  model: string | null
  reasoning_effort: string | null
  approval_mode: string | null
  created_at: string
  updated_at: string
}

export interface ExecutionProfileListFilter {
  readonly agentId?: string | undefined
}

export interface CreateExecutionProfileInput {
  readonly id: string
  readonly name: string
  readonly agentId: string
  readonly accountProfileId?: string | undefined
  readonly model?: string | undefined
  readonly reasoningEffort?: string | undefined
  readonly approvalMode?: ApprovalMode | undefined
}

/** `null` clears a nullable column; `undefined` leaves it untouched. */
export interface UpdateExecutionProfileInput {
  readonly name?: string | undefined
  readonly accountProfileId?: string | null | undefined
  readonly model?: string | null | undefined
  readonly reasoningEffort?: string | null | undefined
  readonly approvalMode?: ApprovalMode | null | undefined
}

export interface ExecutionProfileRepository {
  list(filter?: ExecutionProfileListFilter): IpcResult<AgentExecutionProfile[]>
  getById(id: string): IpcResult<AgentExecutionProfile | null>
  create(input: CreateExecutionProfileInput, now?: string): IpcResult<AgentExecutionProfile>
  update(
    id: string,
    patch: UpdateExecutionProfileInput,
    now?: string,
  ): IpcResult<AgentExecutionProfile | null>
  /** Hard delete. Returns false when the row did not exist. */
  delete(id: string): IpcResult<boolean>
}

const ENTITY = 'execution-profile'

function toDomain(row: ExecutionProfileRow): IpcResult<AgentExecutionProfile> {
  return validateRow(executionProfileRecordSchema, ENTITY, {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    accountProfileId: row.account_profile_id ?? undefined,
    model: row.model ?? undefined,
    reasoningEffort: row.reasoning_effort ?? undefined,
    approvalMode: row.approval_mode ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export function createExecutionProfileRepository(
  connection: Database.Database,
): ExecutionProfileRepository {
  const readById = (id: string): IpcResult<AgentExecutionProfile | null> => {
    const row = execute(ENTITY, 'read', () => {
      return connection.prepare('SELECT * FROM agent_execution_profiles WHERE id = ?').get(id) as
        ExecutionProfileRow | undefined
    })
    if (!row.ok) {
      return row
    }
    if (row.data === undefined) {
      return { ok: true, data: null }
    }
    return toDomain(row.data)
  }

  return {
    list(filter = {}) {
      const conditions: string[] = []
      const values: unknown[] = []
      if (filter.agentId !== undefined) {
        conditions.push('agent_id = ?')
        values.push(filter.agentId)
      }
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
      const rows = execute(ENTITY, 'list', () => {
        return connection
          .prepare(`SELECT * FROM agent_execution_profiles${where} ORDER BY created_at ASC`)
          .all(...values) as ExecutionProfileRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toDomain)
    },

    getById: readById,

    create(input, now = nowIso()) {
      const inserted = execute(ENTITY, 'create', () => {
        connection
          .prepare(
            `INSERT INTO agent_execution_profiles (id, name, agent_id, account_profile_id, model, reasoning_effort, approval_mode, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.name,
            input.agentId,
            input.accountProfileId ?? null,
            input.model ?? null,
            input.reasoningEffort ?? null,
            input.approvalMode ?? null,
            now,
            now,
          )
      })
      if (!inserted.ok) {
        return inserted
      }
      return requireFound(ENTITY, readById(input.id))
    },

    update(id, patch, now = nowIso()) {
      const columnByField = {
        name: 'name',
        accountProfileId: 'account_profile_id',
        model: 'model',
        reasoningEffort: 'reasoning_effort',
        approvalMode: 'approval_mode',
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
      if (sets.length === 0) {
        return readById(id)
      }
      sets.push('updated_at = ?')
      values.push(now, id)
      const updated = execute(ENTITY, 'update', () => {
        return connection
          .prepare(`UPDATE agent_execution_profiles SET ${sets.join(', ')} WHERE id = ?`)
          .run(...values).changes
      })
      if (!updated.ok) {
        return updated
      }
      if (updated.data === 0) {
        return { ok: true, data: null }
      }
      return readById(id)
    },

    delete(id) {
      return execute(ENTITY, 'delete', () => {
        return (
          connection.prepare('DELETE FROM agent_execution_profiles WHERE id = ?').run(id).changes >
          0
        )
      })
    },
  }
}
