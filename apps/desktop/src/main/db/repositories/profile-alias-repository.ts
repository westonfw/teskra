import type Database from 'better-sqlite3'

import type { IpcResult, ProfileAlias, ProfileAliasKind } from '@teskra/contracts'
import { profileAliasSchema } from '@teskra/contracts'

import { execute, mapRows, nowIso, requireFound, validateRow } from './common'

/**
 * ProfileAliasRepository (TASK-111, Milestone 24 §53.1 / ADR-0011) — the
 * `profile_aliases` table (migration 012).
 *
 * The table is the only mapping between a repo-committed alias and a
 * machine-local Profile id. Its primary key is `(agent_id, kind, alias)`, and
 * it deliberately has NO foreign keys into the two Profile tables: deleting a
 * Profile leaves the binding behind as "unbound" (resolution then fails with
 * a bind prompt) instead of cascading.
 *
 * `bind` is an UPSERT: re-binding an alias to a different Profile is the
 * normal Settings flow, so a conflicting primary key updates `profile_id`
 * instead of failing. Cross-object validation (profileId exists in the kind's
 * table, `profile.agentId` matches) is the Manager's job — this layer only
 * stores rows.
 */

interface ProfileAliasRow {
  agent_id: string
  alias: string
  kind: string
  profile_id: string
  created_at: string
  updated_at: string
}

export interface ProfileAliasListFilter {
  readonly agentId?: string | undefined
  readonly kind?: ProfileAliasKind | undefined
}

export interface ProfileAliasRepository {
  list(filter?: ProfileAliasListFilter): IpcResult<ProfileAlias[]>
  /** Upserts the (agentId, kind, alias) binding; returns the stored row. */
  bind(
    input: { agentId: string; kind: ProfileAliasKind; alias: string; profileId: string },
    now?: string,
  ): IpcResult<ProfileAlias>
  /** Returns false when no such binding existed. */
  unbind(agentId: string, kind: ProfileAliasKind, alias: string): IpcResult<boolean>
  /** Resolves one binding to its profileId; undefined when unbound. */
  resolve(agentId: string, kind: ProfileAliasKind, alias: string): IpcResult<string | undefined>
}

const ENTITY = 'profile-alias'

function toDomain(row: ProfileAliasRow): IpcResult<ProfileAlias> {
  return validateRow(profileAliasSchema, ENTITY, {
    agentId: row.agent_id,
    kind: row.kind,
    alias: row.alias,
    profileId: row.profile_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

export function createProfileAliasRepository(
  connection: Database.Database,
): ProfileAliasRepository {
  const readOne = (
    agentId: string,
    kind: ProfileAliasKind,
    alias: string,
  ): IpcResult<ProfileAlias | null> => {
    const row = execute(ENTITY, 'read', () => {
      return connection
        .prepare('SELECT * FROM profile_aliases WHERE agent_id = ? AND kind = ? AND alias = ?')
        .get(agentId, kind, alias) as ProfileAliasRow | undefined
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
      if (filter.kind !== undefined) {
        conditions.push('kind = ?')
        values.push(filter.kind)
      }
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
      const rows = execute(ENTITY, 'list', () => {
        return connection
          .prepare(
            `SELECT * FROM profile_aliases${where} ORDER BY agent_id ASC, kind ASC, alias ASC`,
          )
          .all(...values) as ProfileAliasRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, toDomain)
    },

    bind(input, now = nowIso()) {
      const written = execute(ENTITY, 'bind', () => {
        connection
          .prepare(
            `INSERT INTO profile_aliases (agent_id, kind, alias, profile_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (agent_id, kind, alias)
             DO UPDATE SET profile_id = excluded.profile_id, updated_at = excluded.updated_at`,
          )
          .run(input.agentId, input.kind, input.alias, input.profileId, now, now)
      })
      if (!written.ok) {
        return written
      }
      return requireFound(ENTITY, readOne(input.agentId, input.kind, input.alias))
    },

    unbind(agentId, kind, alias) {
      return execute(ENTITY, 'unbind', () => {
        return (
          connection
            .prepare('DELETE FROM profile_aliases WHERE agent_id = ? AND kind = ? AND alias = ?')
            .run(agentId, kind, alias).changes > 0
        )
      })
    },

    resolve(agentId, kind, alias) {
      const row = execute(ENTITY, 'resolve', () => {
        return connection
          .prepare(
            'SELECT profile_id FROM profile_aliases WHERE agent_id = ? AND kind = ? AND alias = ?',
          )
          .get(agentId, kind, alias) as { profile_id: string } | undefined
      })
      if (!row.ok) {
        return row
      }
      return { ok: true, data: row.data?.profile_id }
    },
  }
}
