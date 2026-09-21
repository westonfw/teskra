import type Database from 'better-sqlite3'

import type {
  DecisionDetail,
  DecisionKind,
  DecisionOption,
  DecisionResolution,
  DecisionStatus,
  IpcResult,
  PendingDecision,
} from '@teskra/contracts'
import {
  decisionDetailSchema,
  decisionResolutionSchema,
  pendingDecisionSchema,
} from '@teskra/contracts'
import { z } from 'zod'

import { toPublicError } from '../errors'
import {
  decodeJson,
  encodeJson,
  execute,
  mapRows,
  nowIso,
  requireFound,
  validateRow,
} from '../db/repositories/common'

/**
 * DecisionRepository (TASK-128, teskra-tasks.md; ADR-0014; DDL: plan §139.1
 * migration 019) — the `pending_decisions` table.
 *
 * Idempotency and concurrency are database-enforced (ADR-0014 §2): the
 * partial unique index `idx_pending_decisions_open_dedupe` (WHERE status =
 * 'open') is the concurrency guard for `open()`, and every close is a CAS
 * (`UPDATE ... WHERE id = ? AND status = 'open'`) so a decision can only
 * leave `open` once. `detail_json` / `options_json` / `resolution_json` are
 * decoded and Zod-validated on every read — corrupted rows surface as
 * VALIDATION_FAILED, never raw throws.
 */

interface PendingDecisionRow {
  id: string
  workspace_id: string
  kind: string
  status: string
  severity: string
  run_id: string | null
  workflow_run_id: string | null
  workflow_step_id: string | null
  worktree_id: string | null
  dedupe_key: string
  title: string
  detail_json: string
  options_json: string
  resolution_json: string | null
  expires_at: string | null
  created_at: string
  resolved_at: string | null
}

export interface InsertDecisionInput {
  readonly id: string
  readonly workspaceId: string
  readonly kind: DecisionKind
  readonly severity: PendingDecision['severity']
  readonly dedupeKey: string
  readonly title: string
  readonly detail: DecisionDetail
  readonly options: readonly DecisionOption[]
  readonly runId?: string
  readonly workflowRunId?: string
  readonly workflowStepId?: string
  readonly worktreeId?: string
  /** ISO timestamp; undefined = the decision never expires (timeout 0). */
  readonly expiresAt?: string
}

export interface DecisionListFilter {
  readonly workspaceId?: string | undefined
  readonly kind?: DecisionKind | undefined
  readonly status?: DecisionStatus | undefined
}

/** The close side of the open→closed CAS; `resolution` stays NULL for plain cancellations. */
export interface CloseDecisionInput {
  readonly status: 'resolved' | 'expired' | 'cancelled'
  readonly resolution?: DecisionResolution | undefined
}

export interface DecisionSourceRef {
  readonly runId?: string | undefined
  readonly workflowRunId?: string | undefined
}

export interface DecisionRepository {
  /**
   * Inserts an `open` row. A second open row with the same dedupe_key trips
   * the partial unique index and comes back as CONFLICT (not UNKNOWN) so the
   * service can fall back to the existing row (§48.1 pattern, ADR-0014 §2).
   */
  insert(input: InsertDecisionInput, now?: string): IpcResult<PendingDecision>
  getById(id: string): IpcResult<PendingDecision | null>
  getOpenByDedupeKey(dedupeKey: string): IpcResult<PendingDecision | null>
  /** Newest first. */
  list(filter?: DecisionListFilter): IpcResult<PendingDecision[]>
  /** Open rows whose expires_at is due (`expires_at <= now`); NULL never expires. */
  listExpirable(now?: string): IpcResult<PendingDecision[]>
  listOpenByKind(kind: DecisionKind): IpcResult<PendingDecision[]>
  /** Open rows attached to the given source (runId OR workflowRunId). */
  listOpenBySource(source: DecisionSourceRef): IpcResult<PendingDecision[]>
  /**
   * CAS close: `open → status` with the resolution / resolved_at written in
   * the same UPDATE. Returns null when the row was no longer open (already
   * resolved/expired/cancelled or unknown id) — the caller distinguishes.
   */
  closeOpen(id: string, close: CloseDecisionInput, now?: string): IpcResult<PendingDecision | null>
}

const ENTITY = 'decision'

const optionsSchema = z.array(
  z.strictObject({
    id: z.string().min(1),
    label: z.string().min(1),
    danger: z.boolean().optional(),
  }),
)

function isUniqueViolation(cause: unknown): boolean {
  if (cause === null || typeof cause !== 'object') {
    return false
  }
  const candidate = cause as { code?: unknown; message?: unknown }
  const code = typeof candidate.code === 'string' ? candidate.code : ''
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  return code.startsWith('SQLITE_CONSTRAINT') && message.includes('UNIQUE constraint failed')
}

function toDomain(row: PendingDecisionRow): IpcResult<PendingDecision> {
  const detail = decodeJson(decisionDetailSchema, ENTITY, 'detail_json', row.detail_json)
  if (!detail.ok) {
    return detail
  }
  const options = decodeJson(optionsSchema, ENTITY, 'options_json', row.options_json)
  if (!options.ok) {
    return options
  }
  const resolution = decodeJson(
    decisionResolutionSchema,
    ENTITY,
    'resolution_json',
    row.resolution_json,
  )
  if (!resolution.ok) {
    return resolution
  }
  return validateRow(pendingDecisionSchema, ENTITY, {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    status: row.status,
    severity: row.severity,
    runId: row.run_id ?? undefined,
    workflowRunId: row.workflow_run_id ?? undefined,
    workflowStepId: row.workflow_step_id ?? undefined,
    worktreeId: row.worktree_id ?? undefined,
    dedupeKey: row.dedupe_key,
    title: row.title,
    detail: detail.data,
    options: options.data,
    resolution: resolution.data,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  })
}

export function createDecisionRepository(connection: Database.Database): DecisionRepository {
  const readOne = (
    operation: string,
    sql: string,
    ...values: unknown[]
  ): IpcResult<PendingDecision | null> => {
    const row = execute(ENTITY, operation, () => {
      return connection.prepare(sql).get(...values) as PendingDecisionRow | undefined
    })
    if (!row.ok) {
      return row
    }
    if (row.data === undefined) {
      return { ok: true, data: null }
    }
    return toDomain(row.data)
  }

  const queryRows = (
    operation: string,
    sql: string,
    ...values: unknown[]
  ): IpcResult<PendingDecision[]> => {
    const rows = execute(ENTITY, operation, () => {
      return connection.prepare(sql).all(...values) as PendingDecisionRow[]
    })
    if (!rows.ok) {
      return rows
    }
    return mapRows(rows.data, toDomain)
  }

  const repository: DecisionRepository = {
    insert(input, now = nowIso()) {
      // Inline (not via execute()): the idx_pending_decisions_open_dedupe
      // unique violation must stay distinguishable as CONFLICT so open() can
      // turn a lost insert race into "return the existing open row".
      try {
        connection
          .prepare(
            `INSERT INTO pending_decisions (id, workspace_id, kind, status, severity, run_id, workflow_run_id, workflow_step_id, worktree_id, dedupe_key, title, detail_json, options_json, expires_at, created_at)
             VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.workspaceId,
            input.kind,
            input.severity,
            input.runId ?? null,
            input.workflowRunId ?? null,
            input.workflowStepId ?? null,
            input.worktreeId ?? null,
            input.dedupeKey,
            input.title,
            encodeJson(input.detail),
            encodeJson(input.options),
            input.expiresAt ?? null,
            now,
          )
      } catch (cause) {
        return {
          ok: false,
          error: isUniqueViolation(cause)
            ? toPublicError({
                code: 'CONFLICT',
                message: 'An open decision with the same dedupe key already exists.',
                retryable: false,
                detail: 'decision: insert violated idx_pending_decisions_open_dedupe',
                cause,
              })
            : toPublicError({
                code: 'UNKNOWN',
                message: 'Failed to create decision.',
                retryable: false,
                detail: 'decision: insert',
                cause,
              }),
        }
      }
      return requireFound(ENTITY, repository.getById(input.id))
    },

    getById(id) {
      return readOne('read', 'SELECT * FROM pending_decisions WHERE id = ?', id)
    },

    getOpenByDedupeKey(dedupeKey) {
      return readOne(
        'read',
        "SELECT * FROM pending_decisions WHERE dedupe_key = ? AND status = 'open'",
        dedupeKey,
      )
    },

    list(filter = {}) {
      const conditions: string[] = []
      const values: unknown[] = []
      if (filter.workspaceId !== undefined) {
        conditions.push('workspace_id = ?')
        values.push(filter.workspaceId)
      }
      if (filter.kind !== undefined) {
        conditions.push('kind = ?')
        values.push(filter.kind)
      }
      if (filter.status !== undefined) {
        conditions.push('status = ?')
        values.push(filter.status)
      }
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
      return queryRows(
        'list',
        `SELECT * FROM pending_decisions${where} ORDER BY created_at DESC`,
        ...values,
      )
    },

    listExpirable(now = nowIso()) {
      // ISO-8601 UTC text compares correctly as text (same fixed format as
      // every other timestamp column). NULL expires_at = never expires.
      return queryRows(
        'listExpirable',
        "SELECT * FROM pending_decisions WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY created_at ASC",
        now,
      )
    },

    listOpenByKind(kind) {
      return queryRows(
        'listOpenByKind',
        "SELECT * FROM pending_decisions WHERE status = 'open' AND kind = ? ORDER BY created_at ASC",
        kind,
      )
    },

    listOpenBySource(source) {
      const conditions: string[] = []
      const values: unknown[] = []
      if (source.runId !== undefined) {
        conditions.push('run_id = ?')
        values.push(source.runId)
      }
      if (source.workflowRunId !== undefined) {
        conditions.push('workflow_run_id = ?')
        values.push(source.workflowRunId)
      }
      if (conditions.length === 0) {
        return { ok: true, data: [] }
      }
      return queryRows(
        'listOpenBySource',
        `SELECT * FROM pending_decisions WHERE status = 'open' AND (${conditions.join(' OR ')}) ORDER BY created_at ASC`,
        ...values,
      )
    },

    closeOpen(id, close, now = nowIso()) {
      const updated = execute(ENTITY, 'closeOpen', () => {
        return connection
          .prepare(
            `UPDATE pending_decisions
             SET status = ?, resolution_json = ?, resolved_at = ?
             WHERE id = ? AND status = 'open'`,
          )
          .run(close.status, encodeJson(close.resolution), now, id).changes
      })
      if (!updated.ok) {
        return updated
      }
      if (updated.data === 0) {
        return { ok: true, data: null }
      }
      return repository.getById(id)
    },
  }

  return repository
}
