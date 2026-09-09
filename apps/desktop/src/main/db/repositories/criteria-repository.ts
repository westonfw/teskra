import type Database from 'better-sqlite3'
import { z } from 'zod'

import type { IpcResult } from '@teskra/contracts'

import { execute, isoTimestampSchema, mapRows, nowIso, requireFound, validateRow } from './common'

/**
 * CriteriaRepository (TASK-007) — the `acceptance_criteria_sets` and
 * `acceptance_criteria` tables (plan §139.1, 003_criteria_review.sql lines
 * 5333–5353). Sets are immutable versions of a task's acceptance contract:
 * a referenced set can only be superseded, never deleted (ON DELETE
 * RESTRICT from workflow_runs / agent_runs).
 *
 * The enum values are pinned by the §139.1 column comments; contracts has no
 * schemas for them yet, so they are declared here next to the table mapping.
 */

/** §139.1 `acceptance_criteria_sets.status` (line 5337). */
export const CRITERIA_SET_STATUSES = ['draft', 'confirmed', 'superseded'] as const
export const criteriaSetStatusSchema = z.enum(CRITERIA_SET_STATUSES)
export type CriteriaSetStatus = z.infer<typeof criteriaSetStatusSchema>

/** §139.1 `acceptance_criteria.category` (line 5349). */
export const CRITERION_CATEGORIES = [
  'functional',
  'test',
  'performance',
  'security',
  'compatibility',
  'quality',
] as const
export const criterionCategorySchema = z.enum(CRITERION_CATEGORIES)
export type CriterionCategory = z.infer<typeof criterionCategorySchema>

export const acceptanceCriteriaSetRecordSchema = z.strictObject({
  id: z.string(),
  taskId: z.string(),
  version: z.number().int().positive(),
  status: criteriaSetStatusSchema,
  confirmedAt: isoTimestampSchema.optional(),
  createdAt: isoTimestampSchema,
})
export type AcceptanceCriteriaSet = z.infer<typeof acceptanceCriteriaSetRecordSchema>

export const acceptanceCriterionRecordSchema = z.strictObject({
  id: z.string(),
  criteriaSetId: z.string(),
  ordinal: z.number().int().positive(),
  description: z.string(),
  category: criterionCategorySchema.optional(),
  /** `required` column is INTEGER 0/1; mapped to boolean here. */
  required: z.boolean(),
  createdAt: isoTimestampSchema,
})
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionRecordSchema>

interface CriteriaSetRow {
  id: string
  task_id: string
  version: number
  status: string
  confirmed_at: string | null
  created_at: string
}

interface CriterionRow {
  id: string
  criteria_set_id: string
  ordinal: number
  description: string
  category: string | null
  required: number
  created_at: string
}

export interface CreateCriteriaSetInput {
  readonly id: string
  readonly taskId: string
  readonly version: number
  /** Defaults to 'draft'. */
  readonly status?: CriteriaSetStatus
}

export interface CreateCriterionInput {
  readonly id: string
  readonly criteriaSetId: string
  readonly ordinal: number
  readonly description: string
  readonly category?: CriterionCategory
  /** Defaults to true. */
  readonly required?: boolean
}

export interface UpdateCriterionInput {
  readonly ordinal?: number
  readonly description?: string
  readonly category?: CriterionCategory | null
  readonly required?: boolean
}

export interface CriteriaRepository {
  createSet(input: CreateCriteriaSetInput, now?: string): IpcResult<AcceptanceCriteriaSet>
  getSetById(id: string): IpcResult<AcceptanceCriteriaSet | null>
  listSetsByTask(taskId: string): IpcResult<AcceptanceCriteriaSet[]>
  /** Highest-version set for the task, regardless of status. */
  getLatestSet(taskId: string): IpcResult<AcceptanceCriteriaSet | null>
  /** Marks a set confirmed and stamps confirmed_at. */
  confirmSet(id: string, now?: string): IpcResult<AcceptanceCriteriaSet | null>
  supersedeSet(id: string): IpcResult<AcceptanceCriteriaSet | null>
  addCriterion(input: CreateCriterionInput, now?: string): IpcResult<AcceptanceCriterion>
  getCriterionById(id: string): IpcResult<AcceptanceCriterion | null>
  updateCriterion(id: string, patch: UpdateCriterionInput): IpcResult<AcceptanceCriterion | null>
  /** Ordered by ordinal ascending. */
  listCriteria(criteriaSetId: string): IpcResult<AcceptanceCriterion[]>
  deleteCriterion(id: string): IpcResult<boolean>
}

const SET_ENTITY = 'criteria-set'
const CRITERION_ENTITY = 'criterion'

function setToDomain(row: CriteriaSetRow): IpcResult<AcceptanceCriteriaSet> {
  return validateRow(acceptanceCriteriaSetRecordSchema, SET_ENTITY, {
    id: row.id,
    taskId: row.task_id,
    version: row.version,
    status: row.status,
    confirmedAt: row.confirmed_at ?? undefined,
    createdAt: row.created_at,
  })
}

function criterionToDomain(row: CriterionRow): IpcResult<AcceptanceCriterion> {
  return validateRow(acceptanceCriterionRecordSchema, CRITERION_ENTITY, {
    id: row.id,
    criteriaSetId: row.criteria_set_id,
    ordinal: row.ordinal,
    description: row.description,
    category: row.category ?? undefined,
    required: row.required !== 0,
    createdAt: row.created_at,
  })
}

export function createCriteriaRepository(connection: Database.Database): CriteriaRepository {
  const getSetRow = (id: string): CriteriaSetRow | undefined =>
    connection.prepare('SELECT * FROM acceptance_criteria_sets WHERE id = ?').get(id) as
      CriteriaSetRow | undefined

  const getSetById = (id: string): IpcResult<AcceptanceCriteriaSet | null> => {
    const row = execute(SET_ENTITY, 'read', () => getSetRow(id))
    if (!row.ok) {
      return row
    }
    if (row.data === undefined) {
      return { ok: true, data: null }
    }
    return setToDomain(row.data)
  }

  const repository: CriteriaRepository = {
    createSet(input, now = nowIso()) {
      const inserted = execute(SET_ENTITY, 'create', () => {
        connection
          .prepare(
            `INSERT INTO acceptance_criteria_sets (id, task_id, version, status, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(input.id, input.taskId, input.version, input.status ?? 'draft', now)
      })
      if (!inserted.ok) {
        return inserted
      }
      return requireFound(SET_ENTITY, repository.getSetById(input.id))
    },

    getSetById,

    listSetsByTask(taskId) {
      const rows = execute(SET_ENTITY, 'listSetsByTask', () => {
        return connection
          .prepare('SELECT * FROM acceptance_criteria_sets WHERE task_id = ? ORDER BY version DESC')
          .all(taskId) as CriteriaSetRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, setToDomain)
    },

    getLatestSet(taskId) {
      const row = execute(SET_ENTITY, 'getLatestSet', () => {
        return connection
          .prepare(
            'SELECT * FROM acceptance_criteria_sets WHERE task_id = ? ORDER BY version DESC LIMIT 1',
          )
          .get(taskId) as CriteriaSetRow | undefined
      })
      if (!row.ok) {
        return row
      }
      if (row.data === undefined) {
        return { ok: true, data: null }
      }
      return setToDomain(row.data)
    },

    confirmSet(id, now = nowIso()) {
      const updated = execute(SET_ENTITY, 'confirm', () => {
        return connection
          .prepare(
            `UPDATE acceptance_criteria_sets SET status = 'confirmed', confirmed_at = ? WHERE id = ?`,
          )
          .run(now, id).changes
      })
      if (!updated.ok) {
        return updated
      }
      if (updated.data === 0) {
        return { ok: true, data: null }
      }
      return getSetById(id)
    },

    supersedeSet(id) {
      const updated = execute(SET_ENTITY, 'supersede', () => {
        return connection
          .prepare(`UPDATE acceptance_criteria_sets SET status = 'superseded' WHERE id = ?`)
          .run(id).changes
      })
      if (!updated.ok) {
        return updated
      }
      if (updated.data === 0) {
        return { ok: true, data: null }
      }
      return getSetById(id)
    },

    addCriterion(input, now = nowIso()) {
      const inserted = execute(CRITERION_ENTITY, 'create', () => {
        connection
          .prepare(
            `INSERT INTO acceptance_criteria (id, criteria_set_id, ordinal, description, category, required, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.criteriaSetId,
            input.ordinal,
            input.description,
            input.category ?? null,
            input.required === false ? 0 : 1,
            now,
          )
      })
      if (!inserted.ok) {
        return inserted
      }
      return requireFound(CRITERION_ENTITY, repository.getCriterionById(input.id))
    },

    getCriterionById(id) {
      const row = execute(CRITERION_ENTITY, 'read', () => {
        return connection.prepare('SELECT * FROM acceptance_criteria WHERE id = ?').get(id) as
          CriterionRow | undefined
      })
      if (!row.ok) {
        return row
      }
      if (row.data === undefined) {
        return { ok: true, data: null }
      }
      return criterionToDomain(row.data)
    },

    updateCriterion(id, patch) {
      const sets: string[] = []
      const values: unknown[] = []
      if (patch.ordinal !== undefined) {
        sets.push('ordinal = ?')
        values.push(patch.ordinal)
      }
      if (patch.description !== undefined) {
        sets.push('description = ?')
        values.push(patch.description)
      }
      if (patch.category !== undefined) {
        sets.push('category = ?')
        values.push(patch.category)
      }
      if (patch.required !== undefined) {
        sets.push('required = ?')
        values.push(patch.required ? 1 : 0)
      }
      if (sets.length === 0) {
        return repository.getCriterionById(id)
      }
      values.push(id)
      const updated = execute(CRITERION_ENTITY, 'update', () => {
        return connection
          .prepare(`UPDATE acceptance_criteria SET ${sets.join(', ')} WHERE id = ?`)
          .run(...values).changes
      })
      if (!updated.ok) {
        return updated
      }
      if (updated.data === 0) {
        return { ok: true, data: null }
      }
      return repository.getCriterionById(id)
    },

    listCriteria(criteriaSetId) {
      const rows = execute(CRITERION_ENTITY, 'listCriteria', () => {
        return connection
          .prepare(
            'SELECT * FROM acceptance_criteria WHERE criteria_set_id = ? ORDER BY ordinal ASC',
          )
          .all(criteriaSetId) as CriterionRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, criterionToDomain)
    },

    deleteCriterion(id) {
      return execute(CRITERION_ENTITY, 'delete', () => {
        return (
          connection.prepare('DELETE FROM acceptance_criteria WHERE id = ?').run(id).changes > 0
        )
      })
    },
  }

  return repository
}
