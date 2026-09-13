import type Database from 'better-sqlite3'

import type {
  AccountAuthType,
  AccountProfileStatus,
  AgentAccountProfile,
  IpcResult,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'
import { agentAccountProfileSchema } from '@teskra/contracts'

import { toPublicError } from '../../errors'
import { execute, mapRows, nowIso, requireFound, validateRow } from './common'

/**
 * AccountProfileRepository (TASK-096, Milestone 24 / ADR-0009) — the
 * `agent_account_profiles` table (migration 012, design doc §8.1).
 *
 * Owns the row ↔ domain mapping duties for account profiles:
 *
 * - `runtime` is flattened into `runtime_kind` / `wsl_distro` (design §5.1);
 *   `wsl_distro` is lowercased on write (distro names are case-insensitive
 *   and the column backs the per-runtime config_home unique index).
 * - `enabled` is the INTEGER management flag ↔ domain boolean (§16: the
 *   single source of truth for the management state).
 * - `config_home` and the timestamp columns are nullable; domain uses
 *   `undefined`.
 * - The partial unique index `idx_agent_account_profiles_home`
 *   ((runtime_kind, IFNULL(wsl_distro,''), config_home)) surfaces as a
 *   distinguishable CONFLICT error so the Manager can ask for a new slug
 *   instead of reporting a generic failure (§48.1 third line of defense).
 */

export const accountProfileRecordSchema = agentAccountProfileSchema
export type { AgentAccountProfile } from '@teskra/contracts'

interface AccountProfileRow {
  id: string
  agent_id: string
  name: string
  description: string | null
  auth_type: string
  runtime_kind: string
  wsl_distro: string | null
  config_home: string | null
  status: string
  limited_until: string | null
  max_concurrent_runs: number | null
  last_used_at: string | null
  last_successful_at: string | null
  last_failure_at: string | null
  enabled: number
  created_at: string
  updated_at: string
}

export interface AccountProfileListFilter {
  readonly agentId?: string | undefined
  readonly status?: AccountProfileStatus | undefined
  readonly enabled?: boolean | undefined
}

export interface CreateAccountProfileInput {
  readonly id: string
  readonly agentId: string
  readonly name: string
  readonly description?: string | undefined
  readonly authType: AccountAuthType
  readonly runtime: WorkspaceRuntimeRef
  readonly configHome?: string | undefined
  readonly maxConcurrentRuns?: number | undefined
  /** Defaults to 'unknown'. */
  readonly status?: AccountProfileStatus | undefined
  /** Defaults to true. */
  readonly enabled?: boolean | undefined
}

/** `null` clears a nullable column; `undefined` leaves it untouched. */
export interface UpdateAccountProfileInput {
  readonly name?: string
  readonly description?: string | null
  readonly configHome?: string | null
  readonly maxConcurrentRuns?: number | null
  readonly limitedUntil?: string | null
  readonly lastUsedAt?: string | null
  readonly lastSuccessfulAt?: string | null
  readonly lastFailureAt?: string | null
}

export interface AccountProfileStatusPatch {
  readonly status: AccountProfileStatus
  /** `null` clears the column; `undefined` leaves it untouched. */
  readonly limitedUntil?: string | null
  readonly lastUsedAt?: string
  readonly lastSuccessfulAt?: string
  readonly lastFailureAt?: string
}

export interface AccountProfileRepository {
  list(filter?: AccountProfileListFilter): IpcResult<AgentAccountProfile[]>
  getById(id: string): IpcResult<AgentAccountProfile | null>
  create(input: CreateAccountProfileInput, now?: string): IpcResult<AgentAccountProfile>
  update(
    id: string,
    patch: UpdateAccountProfileInput,
    now?: string,
  ): IpcResult<AgentAccountProfile | null>
  /** Soft delete (§47.1): sets enabled = 0. */
  disable(id: string, now?: string): IpcResult<AgentAccountProfile | null>
  setEnabled(id: string, enabled: boolean, now?: string): IpcResult<AgentAccountProfile | null>
  setStatus(
    id: string,
    patch: AccountProfileStatusPatch,
    now?: string,
  ): IpcResult<AgentAccountProfile | null>
  /**
   * Hard delete — ONLY for the create-flow compensation (§9.2: mkdir failed
   * after INSERT, so the just-inserted row must not be left behind). Managers
   * must not expose this as profile removal; removal is soft disable.
   */
  delete(id: string): IpcResult<boolean>
}

const ENTITY = 'account-profile'

function toDomain(row: AccountProfileRow): IpcResult<AgentAccountProfile> {
  return validateRow(accountProfileRecordSchema, ENTITY, {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    description: row.description ?? undefined,
    authType: row.auth_type,
    runtime:
      row.runtime_kind === 'wsl'
        ? { kind: 'wsl', distro: row.wsl_distro ?? '' }
        : { kind: row.runtime_kind },
    configHome: row.config_home ?? undefined,
    maxConcurrentRuns: row.max_concurrent_runs ?? undefined,
    status: row.status,
    limitedUntil: row.limited_until ?? undefined,
    lastUsedAt: row.last_used_at ?? undefined,
    lastSuccessfulAt: row.last_successful_at ?? undefined,
    lastFailureAt: row.last_failure_at ?? undefined,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

/** Distro names are case-insensitive; the unique index depends on this. */
function flattenRuntime(runtime: WorkspaceRuntimeRef): {
  runtimeKind: string
  wslDistro: string | null
} {
  return runtime.kind === 'wsl'
    ? { runtimeKind: 'wsl', wslDistro: (runtime.distro ?? '').toLowerCase() }
    : { runtimeKind: runtime.kind, wslDistro: null }
}

function isUniqueViolation(cause: unknown): boolean {
  if (cause === null || typeof cause !== 'object') {
    return false
  }
  const candidate = cause as { code?: unknown; message?: unknown }
  const code = typeof candidate.code === 'string' ? candidate.code : ''
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  return code.startsWith('SQLITE_CONSTRAINT') && message.includes('UNIQUE constraint failed')
}

export function createAccountProfileRepository(
  connection: Database.Database,
): AccountProfileRepository {
  const readById = (id: string): IpcResult<AgentAccountProfile | null> => {
    const row = execute(ENTITY, 'read', () => {
      return connection.prepare('SELECT * FROM agent_account_profiles WHERE id = ?').get(id) as
        AccountProfileRow | undefined
    })
    if (!row.ok) {
      return row
    }
    if (row.data === undefined) {
      return { ok: true, data: null }
    }
    return toDomain(row.data)
  }

  const repository: AccountProfileRepository = {
    list(filter = {}) {
      const conditions: string[] = []
      const values: unknown[] = []
      if (filter.agentId !== undefined) {
        conditions.push('agent_id = ?')
        values.push(filter.agentId)
      }
      if (filter.status !== undefined) {
        conditions.push('status = ?')
        values.push(filter.status)
      }
      if (filter.enabled !== undefined) {
        conditions.push('enabled = ?')
        values.push(filter.enabled ? 1 : 0)
      }
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
      const rows = execute(ENTITY, 'list', () => {
        return connection
          .prepare(`SELECT * FROM agent_account_profiles${where} ORDER BY created_at ASC`)
          .all(...values) as AccountProfileRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toDomain)
    },

    getById: readById,

    create(input, now = nowIso()) {
      const { runtimeKind, wslDistro } = flattenRuntime(input.runtime)
      // execute() maps every driver error to UNKNOWN, so the INSERT runs
      // inline here: the idx_agent_account_profiles_home unique violation
      // must stay distinguishable as CONFLICT (§48.1 — the Manager turns it
      // into "pick a different slug", not a generic failure).
      let inserted: IpcResult<null>
      try {
        connection
          .prepare(
            `INSERT INTO agent_account_profiles (id, agent_id, name, description, auth_type, runtime_kind, wsl_distro, config_home, status, max_concurrent_runs, enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.agentId,
            input.name,
            input.description ?? null,
            input.authType,
            runtimeKind,
            wslDistro,
            input.configHome ?? null,
            input.status ?? 'unknown',
            input.maxConcurrentRuns ?? null,
            input.enabled === false ? 0 : 1,
            now,
            now,
          )
        inserted = { ok: true, data: null }
      } catch (cause) {
        inserted = {
          ok: false,
          error: isUniqueViolation(cause)
            ? toPublicError({
                code: 'CONFLICT',
                message:
                  'An account profile with the same configHome already exists for this runtime.',
                retryable: false,
                detail: 'account-profile: create violated idx_agent_account_profiles_home',
                cause,
              })
            : toPublicError({
                code: 'UNKNOWN',
                message: 'Failed to create account-profile.',
                retryable: false,
                detail: 'account-profile: create',
                cause,
              }),
        }
      }
      if (!inserted.ok) {
        return inserted
      }
      return requireFound(ENTITY, readById(input.id))
    },

    update(id, patch, now = nowIso()) {
      const columnByField = {
        name: 'name',
        description: 'description',
        configHome: 'config_home',
        maxConcurrentRuns: 'max_concurrent_runs',
        limitedUntil: 'limited_until',
        lastUsedAt: 'last_used_at',
        lastSuccessfulAt: 'last_successful_at',
        lastFailureAt: 'last_failure_at',
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
          .prepare(`UPDATE agent_account_profiles SET ${sets.join(', ')} WHERE id = ?`)
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

    disable(id, now = nowIso()) {
      return repository.setEnabled(id, false, now)
    },

    setEnabled(id, enabled, now = nowIso()) {
      const updated = execute(ENTITY, 'setEnabled', () => {
        return connection
          .prepare('UPDATE agent_account_profiles SET enabled = ?, updated_at = ? WHERE id = ?')
          .run(enabled ? 1 : 0, now, id).changes
      })
      if (!updated.ok) {
        return updated
      }
      if (updated.data === 0) {
        return { ok: true, data: null }
      }
      return readById(id)
    },

    setStatus(id, patch, now = nowIso()) {
      const sets: string[] = ['status = ?']
      const values: unknown[] = [patch.status]
      if (patch.limitedUntil !== undefined) {
        sets.push('limited_until = ?')
        values.push(patch.limitedUntil)
      }
      if (patch.lastUsedAt !== undefined) {
        sets.push('last_used_at = ?')
        values.push(patch.lastUsedAt)
      }
      if (patch.lastSuccessfulAt !== undefined) {
        sets.push('last_successful_at = ?')
        values.push(patch.lastSuccessfulAt)
      }
      if (patch.lastFailureAt !== undefined) {
        sets.push('last_failure_at = ?')
        values.push(patch.lastFailureAt)
      }
      sets.push('updated_at = ?')
      values.push(now, id)
      const updated = execute(ENTITY, 'setStatus', () => {
        return connection
          .prepare(`UPDATE agent_account_profiles SET ${sets.join(', ')} WHERE id = ?`)
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
          connection.prepare('DELETE FROM agent_account_profiles WHERE id = ?').run(id).changes > 0
        )
      })
    },
  }

  return repository
}
