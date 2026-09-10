import { z } from 'zod'

import { criterionResultSchema } from './criteria'
import { reviewSeveritySchema } from './handoff'

/**
 * Review-side records (TASK-053; plan §139.1 `review_findings`). These are the
 * public projections returned over Typed IPC — distinct from the handoff
 * payload shape (`ReviewFinding` in handoff.ts), which is what the reviewer
 * Agent writes and the Main process persists from.
 */

/** Public projection of one persisted `review_findings` row. */
export const reviewFindingRecordSchema = z.strictObject({
  id: z.string(),
  runId: z.string(),
  panelId: z.string().optional(),
  severity: reviewSeveritySchema,
  title: z.string(),
  description: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().optional(),
  criterionId: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
})
export type ReviewFindingRecord = z.infer<typeof reviewFindingRecordSchema>

/** Exactly one of `runId` / `taskId` selects the findings to list. */
export const listReviewFindingsRequestSchema = z
  .strictObject({
    runId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
  })
  .refine((request) => (request.runId === undefined) !== (request.taskId === undefined), {
    message: 'Exactly one of runId / taskId is required.',
  })
export type ListReviewFindingsRequest = z.infer<typeof listReviewFindingsRequestSchema>

/**
 * Public projection of one persisted `criterion_scores` row (plan §139.1,
 * TASK-054). `runId` is the REVIEWED Run (the handoff's targetRunId when
 * declared) so merge preflight can read it straight off the worktree's Run.
 */
export const criterionScoreRecordSchema = z.strictObject({
  id: z.string(),
  runId: z.string(),
  criterionId: z.string(),
  result: criterionResultSchema,
  evidence: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
})
export type CriterionScoreRecord = z.infer<typeof criterionScoreRecordSchema>

/** Exactly one of `runId` / `taskId` selects the scores to list. */
export const listCriterionScoresRequestSchema = z
  .strictObject({
    runId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
  })
  .refine((request) => (request.runId === undefined) !== (request.taskId === undefined), {
    message: 'Exactly one of runId / taskId is required.',
  })
export type ListCriterionScoresRequest = z.infer<typeof listCriterionScoresRequestSchema>

/**
 * TASK-054 overall review outcome, derived from per-criterion scores
 * (packages/shared computeCriteriaReviewOutcome): 'pass' only when EVERY
 * criterion passed, 'fail' when any required criterion failed, otherwise
 * 'unknown' — an unreviewed or unverifiable criterion never auto-passes.
 */
export const CRITERIA_REVIEW_OUTCOMES = ['pass', 'fail', 'unknown'] as const
export const criteriaReviewOutcomeSchema = z.enum(CRITERIA_REVIEW_OUTCOMES)
export type CriteriaReviewOutcome = z.infer<typeof criteriaReviewOutcomeSchema>
