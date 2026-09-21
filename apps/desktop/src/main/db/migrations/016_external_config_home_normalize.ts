import type Database from 'better-sqlite3'

import { normalizeWindowsConfigHome } from '../../agents/accounts/external-config-home'
import { getLogger } from '../../logger'

/**
 * 016_external_config_home_normalize — P2-2 follow-up data migration
 * (code-review-2026-09-21 §11 Low): normalizeExternalConfigHome
 * (agents/accounts/account-profile-manager.ts) only normalizes NEW external
 * profiles; legacy windows-runtime rows stored before P2-2 keep their raw
 * user input (mixed case, trailing slash, forward slashes), so the
 * per-runtime config_home unique index — a raw-byte comparison — still lets
 * `C:\Users\x` and `c:\users\x\` coexist with a freshly imported
 * `c:\users\x`. This migration rewrites those rows to the same normalized
 * form the Manager now stores, via the shared normalizeWindowsConfigHome
 * (agents/accounts/external-config-home.ts) — the single source of the
 * windows storage contract for both writers.
 *
 * Pure data migration (no DDL): the SQL step is a no-op comment and all work
 * happens in the run hook, because win32 path semantics and per-row collision
 * logging are not expressible in SQL.
 *
 * Collision policy: rows are visited oldest-first (created_at, id tiebreak);
 * the first row of a normalized-value group wins and is normalized. Later
 * rows whose config_home would collide with an already-claimed normalized
 * value are left AS STORED (their raw bytes never violate the unique index)
 * and a WARN is logged — the migration must never crash on legacy data. Such
 * a leftover row remains functional (NTFS folds case), and any future import
 * of the same home now conflicts against the normalized winner as intended.
 */

interface ExternalProfileRow {
  readonly id: string
  readonly config_home: string
}

export function normalizeExternalConfigHomes(connection: Database.Database): void {
  const logger = getLogger('account')
  const rows = connection
    .prepare(
      `SELECT id, config_home
       FROM agent_account_profiles
       WHERE runtime_kind = 'windows' AND auth_type = 'external' AND config_home IS NOT NULL
       ORDER BY created_at, id`,
    )
    .all() as ExternalProfileRow[]
  const update = connection.prepare(
    'UPDATE agent_account_profiles SET config_home = ? WHERE id = ?',
  )
  const claimed = new Map<string, string>()
  for (const row of rows) {
    const normalized = normalizeWindowsConfigHome(row.config_home)
    const winner = claimed.get(normalized)
    if (winner !== undefined) {
      logger.warn(
        { profileId: row.id, keptProfileId: winner, configHome: row.config_home, normalized },
        'Migration 016: external profile normalizes to an already-claimed config_home; row left as stored.',
      )
      continue
    }
    claimed.set(normalized, row.id)
    if (normalized !== row.config_home) {
      update.run(normalized, row.id)
    }
  }
}
