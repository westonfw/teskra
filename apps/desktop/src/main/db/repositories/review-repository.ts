import type Database from 'better-sqlite3'
import { z } from 'zod'

import type {
  CriterionResult,
  CriterionScoreRecord,
  IpcResult,
  ReviewFindingRecord,
  ReviewSeverity,
} from '@teskra/contracts'
import { criterionScoreRecordSchema, reviewFindingRecordSchema } from '@teskra/contracts'

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
 * ReviewRepository (TASK-007) — the review-side tables of plan §139.1
 * (003_criteria_review.sql): `review_panels`, `review_panel_members`,
 * `review_findings` (lines 5355–5390) and `criterion_scores`
 * (lines 5392–5400). Enum values are pinned by the §139.1 column comments;
 * `severity` reuses the contracts `reviewSeveritySchema`.
 */

/** §139.1 `review_panels.status` (line 5361). */
export const REVIEW_PANEL_STATUSES = ['running', 'completed', 'failed'] as const
export const reviewPanelStatusSchema = z.enum(REVIEW_PANEL_STATUSES)
export type ReviewPanelStatus = z.infer<typeof reviewPanelStatusSchema>

/** §139.1 `review_panels.consensus` (line 5362). */
export const REVIEW_CONSENSUSES = ['approve', 'changes_requested', 'mixed'] as const
export const reviewConsensusSchema = z.enum(REVIEW_CONSENSUSES)
export type ReviewConsensus = z.infer<typeof reviewConsensusSchema>

/** §139.1 `review_panel_members.verdict` (line 5373). */
export const REVIEW_VERDICTS = ['approve', 'changes_requested', 'unable_to_review'] as const
export const reviewVerdictSchema = z.enum(REVIEW_VERDICTS)
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>

/**
 * §139.1 `criterion_scores.result` (line 5396) is pinned in contracts
 * (`criterionResultSchema`, packages/contracts/src/criteria.ts) so the handoff
 * schema, the persisted record, and Typed IPC all share one enum.
 */

export const reviewPanelRecordSchema = z.strictObject({
  id: z.string(),
  taskId: z.string(),
  workflowRunId: z.string().optional(),
  targetArtifactId: z.string().optional(),
  criteriaSetId: z.string().optional(),
  status: reviewPanelStatusSchema,
  consensus: reviewConsensusSchema.optional(),
  /** ReviewAggregate incl. disagreements; opaque object at this layer. */
  aggregate: jsonRecordSchema.optional(),
  createdAt: isoTimestampSchema,
  completedAt: isoTimestampSchema.optional(),
})
export type ReviewPanel = z.infer<typeof reviewPanelRecordSchema>

export const reviewPanelMemberRecordSchema = z.strictObject({
  id: z.string(),
  panelId: z.string(),
  runId: z.string(),
  agentId: z.string(),
  verdict: reviewVerdictSchema.optional(),
  createdAt: isoTimestampSchema,
})
export type ReviewPanelMember = z.infer<typeof reviewPanelMemberRecordSchema>

/**
 * The persisted finding record shape is the contracts `ReviewFindingRecord`
 * (packages/contracts/src/review.ts) — the same projection that crosses Typed
 * IPC, so the Repository validates rows against the public schema directly.
 * `evidence` mirrors plan §143: an array of Evidence-First strings, stored as
 * a JSON array in `evidence_json`.
 */
export type { ReviewFindingRecord } from '@teskra/contracts'

/**
 * Same reasoning as the finding record: the persisted score shape IS the
 * contracts `CriterionScoreRecord` (packages/contracts/src/review.ts), with
 * plan §123 `evidence` as a string array in `evidence_json`.
 */
export type { CriterionScoreRecord } from '@teskra/contracts'

interface PanelRow {
  id: string
  task_id: string
  workflow_run_id: string | null
  target_artifact_id: string | null
  criteria_set_id: string | null
  status: string
  consensus: string | null
  aggregate_json: string | null
  created_at: string
  completed_at: string | null
}

interface MemberRow {
  id: string
  panel_id: string
  run_id: string
  agent_id: string
  verdict: string | null
  created_at: string
}

interface FindingRow {
  id: string
  run_id: string
  panel_id: string | null
  severity: string
  title: string
  description: string | null
  file: string | null
  line: number | null
  criterion_id: string | null
  evidence_json: string | null
  created_at: string
}

interface ScoreRow {
  id: string
  run_id: string
  criterion_id: string
  result: string
  evidence_json: string | null
  created_at: string
}

export interface CreateReviewPanelInput {
  readonly id: string
  readonly taskId: string
  readonly workflowRunId?: string
  readonly targetArtifactId?: string
  readonly criteriaSetId?: string
  /** Defaults to 'running'. */
  readonly status?: ReviewPanelStatus
}

export interface UpdateReviewPanelInput {
  readonly status?: ReviewPanelStatus
  readonly consensus?: ReviewConsensus | null
  readonly aggregate?: JsonRecord | null
  readonly completedAt?: string | null
}

export interface AddPanelMemberInput {
  readonly id: string
  readonly panelId: string
  readonly runId: string
  readonly agentId: string
  readonly verdict?: ReviewVerdict
}

export interface AddFindingInput {
  readonly id: string
  readonly runId: string
  readonly severity: ReviewSeverity
  readonly title: string
  readonly panelId?: string
  readonly description?: string
  readonly file?: string
  readonly line?: number
  readonly criterionId?: string
  /** plan §143 Evidence-First strings; persisted as a JSON array. */
  readonly evidence?: readonly string[]
}

export interface RecordScoreInput {
  readonly id: string
  readonly runId: string
  readonly criterionId: string
  readonly result: CriterionResult
  /** plan §123: evidence strings; persisted as a JSON array. */
  readonly evidence?: readonly string[]
}

export interface ReviewRepository {
  createPanel(input: CreateReviewPanelInput, now?: string): IpcResult<ReviewPanel>
  getPanelById(id: string): IpcResult<ReviewPanel | null>
  updatePanel(id: string, patch: UpdateReviewPanelInput): IpcResult<ReviewPanel | null>
  listPanelsByTask(taskId: string): IpcResult<ReviewPanel[]>
  addMember(input: AddPanelMemberInput, now?: string): IpcResult<ReviewPanelMember>
  setMemberVerdict(id: string, verdict: ReviewVerdict): IpcResult<ReviewPanelMember | null>
  listMembers(panelId: string): IpcResult<ReviewPanelMember[]>
  addFinding(input: AddFindingInput, now?: string): IpcResult<ReviewFindingRecord>
  listFindingsByPanel(panelId: string): IpcResult<ReviewFindingRecord[]>
  listFindingsByRun(runId: string): IpcResult<ReviewFindingRecord[]>
  /** Findings of every Run belonging to the Task (join via agent_runs). */
  listFindingsByTask(taskId: string): IpcResult<ReviewFindingRecord[]>
  /** Removes a run's findings; returns true when at least one row existed. */
  deleteFindingsByRun(runId: string): IpcResult<boolean>
  /** (run_id, criterion_id) is unique — re-scoring overwrites in place. */
  recordScore(input: RecordScoreInput, now?: string): IpcResult<CriterionScoreRecord>
  listScoresByRun(runId: string): IpcResult<CriterionScoreRecord[]>
  /** Scores of every Run belonging to the Task (join via agent_runs). */
  listScoresByTask(taskId: string): IpcResult<CriterionScoreRecord[]>
}

const PANEL = 'review-panel'
const MEMBER = 'review-panel-member'
const FINDING = 'review-finding'
const SCORE = 'criterion-score'

/** plan §143/§123: review evidence is an array of strings (JSON on disk). */
const evidenceSchema = z.array(z.string())

function panelToDomain(row: PanelRow): IpcResult<ReviewPanel> {
  const aggregate = decodeJson(jsonRecordSchema, PANEL, 'aggregate_json', row.aggregate_json)
  if (!aggregate.ok) {
    return aggregate
  }
  return validateRow(reviewPanelRecordSchema, PANEL, {
    id: row.id,
    taskId: row.task_id,
    workflowRunId: row.workflow_run_id ?? undefined,
    targetArtifactId: row.target_artifact_id ?? undefined,
    criteriaSetId: row.criteria_set_id ?? undefined,
    status: row.status,
    consensus: row.consensus ?? undefined,
    aggregate: aggregate.data,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  })
}

function memberToDomain(row: MemberRow): IpcResult<ReviewPanelMember> {
  return validateRow(reviewPanelMemberRecordSchema, MEMBER, {
    id: row.id,
    panelId: row.panel_id,
    runId: row.run_id,
    agentId: row.agent_id,
    verdict: row.verdict ?? undefined,
    createdAt: row.created_at,
  })
}

function findingToDomain(row: FindingRow): IpcResult<ReviewFindingRecord> {
  const evidence = decodeJson(evidenceSchema, FINDING, 'evidence_json', row.evidence_json)
  if (!evidence.ok) {
    return evidence
  }
  return validateRow(reviewFindingRecordSchema, FINDING, {
    id: row.id,
    runId: row.run_id,
    panelId: row.panel_id ?? undefined,
    severity: row.severity,
    title: row.title,
    description: row.description ?? undefined,
    file: row.file ?? undefined,
    line: row.line ?? undefined,
    criterionId: row.criterion_id ?? undefined,
    evidence: evidence.data,
    createdAt: row.created_at,
  })
}

function scoreToDomain(row: ScoreRow): IpcResult<CriterionScoreRecord> {
  const evidence = decodeJson(evidenceSchema, SCORE, 'evidence_json', row.evidence_json)
  if (!evidence.ok) {
    return evidence
  }
  return validateRow(criterionScoreRecordSchema, SCORE, {
    id: row.id,
    runId: row.run_id,
    criterionId: row.criterion_id,
    result: row.result,
    evidence: evidence.data,
    createdAt: row.created_at,
  })
}

export function createReviewRepository(connection: Database.Database): ReviewRepository {
  const repository: ReviewRepository = {
    createPanel(input, now = nowIso()) {
      const inserted = execute(PANEL, 'create', () => {
        connection
          .prepare(
            `INSERT INTO review_panels (id, task_id, workflow_run_id, target_artifact_id, criteria_set_id, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.taskId,
            input.workflowRunId ?? null,
            input.targetArtifactId ?? null,
            input.criteriaSetId ?? null,
            input.status ?? 'running',
            now,
          )
      })
      if (!inserted.ok) {
        return inserted
      }
      return requireFound(PANEL, repository.getPanelById(input.id))
    },

    getPanelById(id) {
      const row = execute(PANEL, 'read', () => {
        return connection.prepare('SELECT * FROM review_panels WHERE id = ?').get(id) as
          PanelRow | undefined
      })
      if (!row.ok) {
        return row
      }
      if (row.data === undefined) {
        return { ok: true, data: null }
      }
      return panelToDomain(row.data)
    },

    updatePanel(id, patch) {
      const sets: string[] = []
      const values: unknown[] = []
      if (patch.status !== undefined) {
        sets.push('status = ?')
        values.push(patch.status)
      }
      if (patch.consensus !== undefined) {
        sets.push('consensus = ?')
        values.push(patch.consensus)
      }
      if (patch.aggregate !== undefined) {
        sets.push('aggregate_json = ?')
        values.push(patch.aggregate === null ? null : encodeJson(patch.aggregate))
      }
      if (patch.completedAt !== undefined) {
        sets.push('completed_at = ?')
        values.push(patch.completedAt)
      }
      if (sets.length === 0) {
        return repository.getPanelById(id)
      }
      values.push(id)
      const updated = execute(PANEL, 'update', () => {
        return connection
          .prepare(`UPDATE review_panels SET ${sets.join(', ')} WHERE id = ?`)
          .run(...values).changes
      })
      if (!updated.ok) {
        return updated
      }
      if (updated.data === 0) {
        return { ok: true, data: null }
      }
      return repository.getPanelById(id)
    },

    listPanelsByTask(taskId) {
      const rows = execute(PANEL, 'listPanelsByTask', () => {
        return connection
          .prepare('SELECT * FROM review_panels WHERE task_id = ? ORDER BY created_at DESC')
          .all(taskId) as PanelRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, panelToDomain)
    },

    addMember(input, now = nowIso()) {
      const inserted = execute(MEMBER, 'create', () => {
        connection
          .prepare(
            `INSERT INTO review_panel_members (id, panel_id, run_id, agent_id, verdict, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(input.id, input.panelId, input.runId, input.agentId, input.verdict ?? null, now)
      })
      if (!inserted.ok) {
        return inserted
      }
      const row = execute(MEMBER, 'read', () => {
        return connection
          .prepare('SELECT * FROM review_panel_members WHERE id = ?')
          .get(input.id) as MemberRow
      })
      if (!row.ok) {
        return row
      }
      return memberToDomain(row.data)
    },

    setMemberVerdict(id, verdict) {
      const updated = execute(MEMBER, 'setVerdict', () => {
        return connection
          .prepare('UPDATE review_panel_members SET verdict = ? WHERE id = ?')
          .run(verdict, id).changes
      })
      if (!updated.ok) {
        return updated
      }
      if (updated.data === 0) {
        return { ok: true, data: null }
      }
      const row = execute(MEMBER, 'read', () => {
        return connection
          .prepare('SELECT * FROM review_panel_members WHERE id = ?')
          .get(id) as MemberRow
      })
      if (!row.ok) {
        return row
      }
      return memberToDomain(row.data)
    },

    listMembers(panelId) {
      const rows = execute(MEMBER, 'listMembers', () => {
        return connection
          .prepare('SELECT * FROM review_panel_members WHERE panel_id = ? ORDER BY created_at ASC')
          .all(panelId) as MemberRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, memberToDomain)
    },

    addFinding(input, now = nowIso()) {
      const inserted = execute(FINDING, 'create', () => {
        connection
          .prepare(
            `INSERT INTO review_findings (id, run_id, panel_id, severity, title, description, file, line, criterion_id, evidence_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.runId,
            input.panelId ?? null,
            input.severity,
            input.title,
            input.description ?? null,
            input.file ?? null,
            input.line ?? null,
            input.criterionId ?? null,
            encodeJson(input.evidence),
            now,
          )
      })
      if (!inserted.ok) {
        return inserted
      }
      const row = execute(FINDING, 'read', () => {
        return connection
          .prepare('SELECT * FROM review_findings WHERE id = ?')
          .get(input.id) as FindingRow
      })
      if (!row.ok) {
        return row
      }
      return findingToDomain(row.data)
    },

    listFindingsByPanel(panelId) {
      const rows = execute(FINDING, 'listFindingsByPanel', () => {
        return connection
          .prepare('SELECT * FROM review_findings WHERE panel_id = ? ORDER BY created_at ASC')
          .all(panelId) as FindingRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, findingToDomain)
    },

    listFindingsByRun(runId) {
      const rows = execute(FINDING, 'listFindingsByRun', () => {
        return connection
          .prepare('SELECT * FROM review_findings WHERE run_id = ? ORDER BY created_at ASC')
          .all(runId) as FindingRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, findingToDomain)
    },

    listFindingsByTask(taskId) {
      const rows = execute(FINDING, 'listFindingsByTask', () => {
        return connection
          .prepare(
            `SELECT f.* FROM review_findings f
             JOIN agent_runs r ON r.id = f.run_id
             WHERE r.task_id = ? ORDER BY f.created_at ASC`,
          )
          .all(taskId) as FindingRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, findingToDomain)
    },

    deleteFindingsByRun(runId) {
      return execute(FINDING, 'deleteFindingsByRun', () => {
        return connection.prepare('DELETE FROM review_findings WHERE run_id = ?').run(runId)
          .changes > 0
      })
    },

    recordScore(input, now = nowIso()) {
      const upserted = execute(SCORE, 'record', () => {
        connection
          .prepare(
            `INSERT INTO criterion_scores (id, run_id, criterion_id, result, evidence_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (run_id, criterion_id)
             DO UPDATE SET result = excluded.result, evidence_json = excluded.evidence_json`,
          )
          .run(
            input.id,
            input.runId,
            input.criterionId,
            input.result,
            encodeJson(input.evidence),
            now,
          )
      })
      if (!upserted.ok) {
        return upserted
      }
      const row = execute(SCORE, 'read', () => {
        return connection
          .prepare('SELECT * FROM criterion_scores WHERE run_id = ? AND criterion_id = ?')
          .get(input.runId, input.criterionId) as ScoreRow
      })
      if (!row.ok) {
        return row
      }
      return scoreToDomain(row.data)
    },

    listScoresByRun(runId) {
      const rows = execute(SCORE, 'listScoresByRun', () => {
        return connection
          .prepare('SELECT * FROM criterion_scores WHERE run_id = ? ORDER BY created_at ASC')
          .all(runId) as ScoreRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, scoreToDomain)
    },

    listScoresByTask(taskId) {
      const rows = execute(SCORE, 'listScoresByTask', () => {
        return connection
          .prepare(
            `SELECT s.* FROM criterion_scores s
             JOIN agent_runs r ON r.id = s.run_id
             WHERE r.task_id = ? ORDER BY s.created_at ASC`,
          )
          .all(taskId) as ScoreRow[]
      })
      if (!rows.ok) {
        return rows
      }
      return mapRows(rows.data, scoreToDomain)
    },
  }

  return repository
}
