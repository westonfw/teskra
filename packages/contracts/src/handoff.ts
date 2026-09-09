import { z } from 'zod'

/**
 * plan §125 WorkerHandoff + TASK-051 + ADR-0004 — delivered via the file at
 * TESKRA_HANDOFF_PATH, never parsed from stdout. Values mirror §139.1:
 * `handoffs.type` (line 5422), `handoffs.parse_status` (line 5426),
 * `review_findings.severity` (line 5381).
 */
export const HANDOFF_TYPES = ['implementation', 'review', 'test', 'analysis', 'blocker'] as const
export const handoffTypeSchema = z.enum(HANDOFF_TYPES)
export type HandoffType = z.infer<typeof handoffTypeSchema>

export const HANDOFF_PARSE_STATUSES = ['ok', 'degraded', 'missing'] as const
export const handoffParseStatusSchema = z.enum(HANDOFF_PARSE_STATUSES)
export type HandoffParseStatus = z.infer<typeof handoffParseStatusSchema>

export const REVIEW_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export const reviewSeveritySchema = z.enum(REVIEW_SEVERITIES)
export type ReviewSeverity = z.infer<typeof reviewSeveritySchema>

export const commandEvidenceSchema = z.strictObject({
  command: z.string(),
  exitCode: z.number().int(),
})
export type CommandEvidence = z.infer<typeof commandEvidenceSchema>

export const testEvidenceSchema = z.strictObject({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string().optional(),
})
export type TestEvidence = z.infer<typeof testEvidenceSchema>

export const reviewFindingSchema = z.strictObject({
  severity: reviewSeveritySchema,
  title: z.string(),
  description: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().optional(),
})
export type ReviewFinding = z.infer<typeof reviewFindingSchema>

export const workerHandoffSchema = z.strictObject({
  runId: z.string(),
  type: handoffTypeSchema,
  summary: z.string(),
  filesChanged: z.array(z.string()).optional(),
  commandsRun: z.array(commandEvidenceSchema).optional(),
  tests: z.array(testEvidenceSchema).optional(),
  findings: z.array(reviewFindingSchema).optional(),
  blockers: z.array(z.string()).optional(),
  suggestedNextAction: z.string().optional(),
})
export type WorkerHandoff = z.infer<typeof workerHandoffSchema>
