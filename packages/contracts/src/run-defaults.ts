import { z } from 'zod'

import { agentRoleSchema } from './agent'
import { ipcIdSchema } from './limits'

/**
 * TASK-134 (Milestone 26 §6) — DefaultSelectionService contract: the
 * explainable run defaults behind the thread-first quick-start input.
 *
 * `reasons` are structured i18n references (`key` = a `runDefaults.*`
 * dictionary entry, `params` = interpolation values) so the Renderer can
 * show WHY every field has its value without Main shipping localized text.
 */

export const runDefaultReasonSchema = z.strictObject({
  /** Renderer dictionary key under `runDefaults.reason.*`. */
  key: z.string().min(1),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
})
export type RunDefaultReason = z.infer<typeof runDefaultReasonSchema>

/**
 * The resolved defaults for starting one thread-mode Run. `mode`,
 * `executionMode`, `approvalMode` and `isolation` are fixed by the
 * thread-first design (Milestone 26 硬约束: exec only, no attended+manual);
 * only the Agent / account / execution profile are actually selected.
 */
export const resolvedRunDefaultsSchema = z.strictObject({
  agentType: z.string().min(1),
  /** AccountProfileManager.getDefault(agentType); absent = legacy CLI environment. */
  accountProfileId: z.string().min(1).optional(),
  /** config.agents.defaultExecutionProfiles[agentType]; absent = no profile. */
  executionProfileId: z.string().min(1).optional(),
  mode: z.literal('exec'),
  executionMode: z.literal('orchestrated'),
  approvalMode: z.literal('safe-auto'),
  isolation: z.literal('worktree'),
  reasons: z.array(runDefaultReasonSchema),
})
export type ResolvedRunDefaults = z.infer<typeof resolvedRunDefaultsSchema>

export const resolveRunDefaultsRequestSchema = z.strictObject({
  workspaceId: ipcIdSchema,
  /** Defaults to 'implementer' (design doc §6). */
  role: agentRoleSchema.optional(),
})
export type ResolveRunDefaultsRequest = z.infer<typeof resolveRunDefaultsRequestSchema>

/**
 * Workflow launcher defaults (design doc §6, consumed by TASK-137):
 * `implementer` is the full resolution for role 'implementer'; `reviewers`
 * are every healthy Agent whose default role is 'reviewer', minus the
 * implementer.
 */
export const workflowRunDefaultsSchema = z.strictObject({
  implementer: resolvedRunDefaultsSchema,
  reviewers: z.array(z.string().min(1)),
})
export type WorkflowRunDefaults = z.infer<typeof workflowRunDefaultsSchema>
