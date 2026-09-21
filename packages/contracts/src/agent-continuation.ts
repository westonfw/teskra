import { z } from 'zod'

import { IPC_TEXT_MAX, ipcIdSchema } from './limits'

/**
 * Milestone 24 §19/§20/§28 — Cross-profile Continuation
 * (docs/teskra-multi-account-subscription-implementation.md). A continuation
 * is a NEW AgentRun on the SAME task and the SAME worktree, launched under a
 * different account identity: the source run is never reused (§19.1) and its
 * context is carried over as a Handoff-backed prompt (§20/§39), never as a
 * native session resume.
 */

/** §20 — why the continuation exists (drives the audit payload, §41). */
export const AGENT_CONTINUATION_REASONS = [
  'rate-limit',
  'manual-switch',
  'agent-failure',
  'delegation',
] as const
export const agentContinuationReasonSchema = z.enum(AGENT_CONTINUATION_REASONS)
export type AgentContinuationReason = z.infer<typeof agentContinuationReasonSchema>

/**
 * §20 — the context package handed from the source run to the target run.
 * Built by the Main-side ContinuationBuilder from the source run row, its
 * collected handoff (ADR-0004), artifacts, and acceptance criteria.
 */
export const agentContinuationSchema = z.strictObject({
  sourceRunId: z.string().min(1),
  reason: agentContinuationReasonSchema,
  taskId: z.string().min(1).optional(),
  workspaceId: z.string().min(1),
  /** §21: the target run reuses the source worktree — never a new one. */
  worktreeId: z.string().min(1).optional(),
  summary: z.string(),
  changedFiles: z.array(z.string()).optional(),
  artifactIds: z.array(z.string().min(1)).optional(),
  acceptanceCriteria: z.array(z.unknown()).optional(),
  previousAgentId: z.string().min(1),
  previousAccountProfileId: z.string().min(1).optional(),
})
export type AgentContinuation = z.infer<typeof agentContinuationSchema>

/**
 * §28 — `teskra:agent:continue-with-profile` request. The target account /
 * execution profile is validated by the §37 selector against `targetAgentId`
 * (match, enabled, runtime compatibility) at launch time.
 */
export const continueAgentRunRequestSchema = z.strictObject({
  sourceRunId: ipcIdSchema,
  targetAgentId: ipcIdSchema,
  targetAccountProfileId: ipcIdSchema.optional(),
  targetExecutionProfileId: ipcIdSchema.optional(),
  /**
   * P1-2 (docs/code-review-2026-09-21.md §3): the caller-declared reason for
   * the switch. Flow B (live source run) only runs the output-tail text
   * classifier when this is 'rate-limit' — a plain manual switch must never
   * re-label the source profile as limited because its terminal output
   * happened to mention a rate limit. Flow A (source already terminal)
   * ignores this field entirely: the persisted terminal classification is the
   * source of truth. When omitted in flow B, Main derives the reason from the
   * classification registered by failAndStop.
   */
  reason: agentContinuationReasonSchema.optional(),
})
export type ContinueAgentRunRequest = z.infer<typeof continueAgentRunRequestSchema>

/** §19.2: the continuation prompt never exceeds the normal IPC text budget. */
export const CONTINUATION_PROMPT_MAX = IPC_TEXT_MAX
