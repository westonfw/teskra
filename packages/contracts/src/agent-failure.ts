import { z } from 'zod'

/**
 * Milestone 24 / ADR-0010 — post-hoc classification of why an Agent Run failed
 * (docs/teskra-multi-account-subscription-implementation.md §17). A rate limit
 * or auth failure is a failure *reason*, not a Run status: the Run stays
 * `failed` and the classification is persisted in
 * `agent_runs.failure_classification_json` (migration 013).
 */
export const AGENT_FAILURE_KINDS = [
  'rate-limited',
  'authentication-required',
  'authentication-expired',
  'network',
  'permission',
  'process-crash',
  'unknown',
] as const
export const agentFailureKindSchema = z.enum(AGENT_FAILURE_KINDS)
export type AgentFailureKind = z.infer<typeof agentFailureKindSchema>

/**
 * §17.3 — dedicated safety cap for `evidence` (a short, secret-masked excerpt
 * of the Agent output), deliberately far below the generic IPC_TEXT_MAX.
 */
export const AGENT_FAILURE_EVIDENCE_MAX = 512

export const agentFailureClassificationSchema = z.strictObject({
  kind: agentFailureKindSchema,
  resetAt: z.string().datetime().optional(),
  retryable: z.boolean(),
  /** Masked, single-line excerpt capped at AGENT_FAILURE_EVIDENCE_MAX (§17.3). */
  evidence: z.string().max(AGENT_FAILURE_EVIDENCE_MAX).optional(),
})
export type AgentFailureClassification = z.infer<typeof agentFailureClassificationSchema>
