import { z } from 'zod'

import { reviewIsolationSchema } from './agent'
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

/**
 * Review Panel (TASK-060; plan §141/§142; §139.1 `review_panels` /
 * `review_panel_members`). One panel = one row in `review_panels`; every
 * reviewer Run = one `review_panel_members` row (the per-reviewer independent
 * review record) plus that Run's own `review_findings` rows.
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

/** TASK-061 severity-policy verdict; computed by the Review Aggregator. */
export const REVIEW_PANEL_VERDICTS = ['pass', 'block'] as const
export const reviewPanelVerdictSchema = z.enum(REVIEW_PANEL_VERDICTS)
export type ReviewPanelVerdict = z.infer<typeof reviewPanelVerdictSchema>

/** Finding counts by severity, for one reviewer or a whole panel. */
export const reviewSeverityCountsSchema = z.strictObject({
  critical: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative(),
})
export type ReviewSeverityCounts = z.infer<typeof reviewSeverityCountsSchema>

/** One reviewer's contribution to a panel aggregate (plan §141 member view). */
export const reviewReviewerSummarySchema = z.strictObject({
  runId: z.string(),
  agentId: z.string(),
  verdict: reviewVerdictSchema,
  /** The isolation tier the reviewer actually ran under (TASK-052). */
  isolation: reviewIsolationSchema,
  findings: reviewSeverityCountsSchema,
})
export type ReviewReviewerSummary = z.infer<typeof reviewReviewerSummarySchema>

/**
 * A point where reviewers disagree (plan §141 `disagreements`). Disagreement
 * is preserved explicitly — every reviewer's differing position stays visible
 * and is never collapsed by majority voting (plan §142).
 */
export const REVIEW_DISAGREEMENT_KINDS = ['verdict', 'criterion', 'location'] as const
export const reviewDisagreementKindSchema = z.enum(REVIEW_DISAGREEMENT_KINDS)
export const reviewDisagreementSchema = z.strictObject({
  kind: reviewDisagreementKindSchema,
  /** What the disagreement is about: 'panel', a criterionId, or a file path. */
  subject: z.string(),
  /** Each reviewer's differing position (verdict or severity), min 2 sides. */
  positions: z
    .array(
      z.strictObject({
        runId: z.string(),
        agentId: z.string(),
        position: z.string(),
      }),
    )
    .min(2),
})
export type ReviewDisagreement = z.infer<typeof reviewDisagreementSchema>

/**
 * plan §141 ReviewAggregate — the panel-level convergence record persisted in
 * `review_panels.aggregate_json`. `verdict` / `reasons` are the TASK-061
 * severity-policy output: absent until the Review Aggregator evaluates the
 * panel (a panel row written before aggregation still validates).
 */
export const reviewAggregateSchema = z.strictObject({
  panelId: z.string(),
  consensus: reviewConsensusSchema,
  reviewers: z.array(reviewReviewerSummarySchema),
  /** Every finding of every reviewer, most severe first. */
  findings: z.array(reviewFindingRecordSchema),
  disagreements: z.array(reviewDisagreementSchema),
  verdict: reviewPanelVerdictSchema.optional(),
  reasons: z.array(z.string()).optional(),
})
export type ReviewAggregate = z.infer<typeof reviewAggregateSchema>

/** Public projection of a `review_panels` row, safe for Typed IPC. */
export const reviewPanelSchema = z.strictObject({
  id: z.string(),
  taskId: z.string(),
  workflowRunId: z.string().optional(),
  targetArtifactId: z.string().optional(),
  criteriaSetId: z.string().optional(),
  status: reviewPanelStatusSchema,
  consensus: reviewConsensusSchema.optional(),
  aggregate: reviewAggregateSchema.optional(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
})
export type ReviewPanel = z.infer<typeof reviewPanelSchema>

/** Public projection of a `review_panel_members` row. */
export const reviewPanelMemberSchema = z.strictObject({
  id: z.string(),
  panelId: z.string(),
  runId: z.string(),
  agentId: z.string(),
  verdict: reviewVerdictSchema.optional(),
  createdAt: z.string().datetime(),
})
export type ReviewPanelMember = z.infer<typeof reviewPanelMemberSchema>

/**
 * One reviewer's independent result inside a panel: its member row, the
 * isolation tier it launched under (known only while the panel service holds
 * it — not persisted on the member row), and its own findings.
 */
export const reviewPanelMemberResultSchema = z.strictObject({
  member: reviewPanelMemberSchema,
  isolation: reviewIsolationSchema.optional(),
  findings: z.array(reviewFindingRecordSchema),
})
export type ReviewPanelMemberResult = z.infer<typeof reviewPanelMemberResultSchema>

/** Full panel view: the panel row plus every reviewer's independent result. */
export const reviewPanelResultSchema = z.strictObject({
  panel: reviewPanelSchema,
  members: z.array(reviewPanelMemberResultSchema),
})
export type ReviewPanelResult = z.infer<typeof reviewPanelResultSchema>

/**
 * TASK-060: starts a Review Panel — `reviewers` are AgentRegistry ids, each
 * launched as an independent reviewer Run (parallel, mutually isolated). The
 * review target resolves exactly like ReviewerService (targetWorktreeId, then
 * targetRunId, then the latest worktree-bound Run of the task).
 */
export const startReviewPanelRequestSchema = z.strictObject({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  reviewers: z.array(z.string().min(1)).min(1),
  targetRunId: z.string().min(1).optional(),
  targetWorktreeId: z.string().min(1).optional(),
  /** Set when the panel is driven by a WorkflowEngine review-panel node. */
  workflowRunId: z.string().min(1).optional(),
  /** Explicit prompt; when omitted the 'review' template (TASK-079) is rendered. */
  prompt: z.string().optional(),
})
export type StartReviewPanelRequest = z.infer<typeof startReviewPanelRequestSchema>

export const reviewPanelIdRequestSchema = z.strictObject({ panelId: z.string().min(1) })
export type ReviewPanelIdRequest = z.infer<typeof reviewPanelIdRequestSchema>

export const listReviewPanelsRequestSchema = z.strictObject({ taskId: z.string().min(1) })
export type ListReviewPanelsRequest = z.infer<typeof listReviewPanelsRequestSchema>
