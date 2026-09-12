import { z } from 'zod'

/**
 * TASK-048 AcceptanceCriteria Domain — values mirror §139.1:
 * `acceptance_criteria_sets.status` (line 5337) and
 * `acceptance_criteria.category` (line 5349).
 *
 * A criteria set is an immutable, versioned acceptance contract for a Task:
 * `draft` sets are editable, `confirmed` sets are frozen and bindable to
 * Agent Runs, and `superseded` sets are kept for audit only. Merge preflight
 * (TASK-045) consumes `confirmed` sets — that status value is load-bearing.
 */
export const CRITERIA_SET_STATUSES = ['draft', 'confirmed', 'superseded'] as const
export const criteriaSetStatusSchema = z.enum(CRITERIA_SET_STATUSES)
export type CriteriaSetStatus = z.infer<typeof criteriaSetStatusSchema>

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

/** Fields mirror the §139.1 `acceptance_criteria_sets` table. */
export const acceptanceCriteriaSetSchema = z.strictObject({
  id: z.string(),
  /** Optional since ADR-0008: a set anchored by a run outlives its task. */
  taskId: z.string().optional(),
  version: z.number().int().positive(),
  status: criteriaSetStatusSchema,
  confirmedAt: z.string().optional(),
  createdAt: z.string(),
})
export type AcceptanceCriteriaSet = z.infer<typeof acceptanceCriteriaSetSchema>

/** Fields mirror the §139.1 `acceptance_criteria` table. */
export const acceptanceCriterionSchema = z.strictObject({
  id: z.string(),
  criteriaSetId: z.string(),
  ordinal: z.number().int().positive(),
  description: z.string(),
  category: criterionCategorySchema.optional(),
  required: z.boolean(),
  createdAt: z.string(),
})
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>

/** A set together with its criteria, ordered by ordinal. */
export const acceptanceCriteriaSetDetailSchema = z.strictObject({
  set: acceptanceCriteriaSetSchema,
  criteria: z.array(acceptanceCriterionSchema),
})
export type AcceptanceCriteriaSetDetail = z.infer<typeof acceptanceCriteriaSetDetailSchema>

/**
 * §139.1 `criterion_scores.result` (line 5396) — the three-state review
 * verdict for one Criterion (TASK-054). `unknown` is explicit: an unreviewed
 * or unverifiable Criterion is never auto-passed.
 */
export const CRITERION_RESULTS = ['pass', 'fail', 'unknown'] as const
export const criterionResultSchema = z.enum(CRITERION_RESULTS)
export type CriterionResult = z.infer<typeof criterionResultSchema>

export const listCriteriaSetsRequestSchema = z.strictObject({
  taskId: z.string().min(1),
})
export type ListCriteriaSetsRequest = z.infer<typeof listCriteriaSetsRequestSchema>

export const criteriaSetIdRequestSchema = z.strictObject({
  setId: z.string().min(1),
})
export type CriteriaSetIdRequest = z.infer<typeof criteriaSetIdRequestSchema>

export const criterionIdRequestSchema = z.strictObject({
  criterionId: z.string().min(1),
})
export type CriterionIdRequest = z.infer<typeof criterionIdRequestSchema>

/** Always creates the next version as a `draft` set for the Task. */
export const createCriteriaSetRequestSchema = z.strictObject({
  taskId: z.string().min(1),
})
export type CreateCriteriaSetRequest = z.infer<typeof createCriteriaSetRequestSchema>

export const addCriterionRequestSchema = z.strictObject({
  setId: z.string().min(1),
  description: z.string().trim().min(1),
  category: criterionCategorySchema.optional(),
  /** Defaults to true. */
  required: z.boolean().optional(),
})
export type AddCriterionRequest = z.infer<typeof addCriterionRequestSchema>

export const updateCriterionRequestSchema = z
  .strictObject({
    criterionId: z.string().min(1),
    description: z.string().trim().min(1).optional(),
    /** Explicit null clears the category. */
    category: criterionCategorySchema.nullable().optional(),
    required: z.boolean().optional(),
    ordinal: z.number().int().positive().optional(),
  })
  .refine(
    ({ description, category, required, ordinal }) =>
      description !== undefined ||
      category !== undefined ||
      required !== undefined ||
      ordinal !== undefined,
    { message: 'At least one Criterion field must be updated.' },
  )
export type UpdateCriterionRequest = z.infer<typeof updateCriterionRequestSchema>

/** `setId: null` clears the run's criteria binding. */
export const bindRunCriteriaRequestSchema = z.strictObject({
  runId: z.string().min(1),
  setId: z.string().min(1).nullable(),
})
export type BindRunCriteriaRequest = z.infer<typeof bindRunCriteriaRequestSchema>
