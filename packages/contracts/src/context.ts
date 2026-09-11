import { z } from 'zod'

/**
 * TASK-068 ContextBuilder domain (plan §47) — packs the prompt context an
 * Agent Run starts with:
 *
 *   Task + Role + Acceptance Criteria + Workspace Memory + Previous Handoff
 *
 * The builder never injects everything: candidate sections are prioritized
 * and packed under a character budget (`budgetChars`); sections that do not
 * fit are dropped lowest-priority-first and counted in `omittedCount` so the
 * user can see that pruning happened. The assembled `content` is the only
 * thing Agent Adapters ever receive (via PromptTemplateService variables) —
 * adapters never gather context themselves.
 */

export const buildContextRequestSchema = z.strictObject({
  workspaceId: z.string().min(1),
  /** When set, the Task, its confirmed criteria and the latest handoff are included. */
  taskId: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  /** Character budget for the assembled content; defaults to the builder's standard budget. */
  budgetChars: z.number().int().min(1).optional(),
})
export type BuildContextRequest = z.infer<typeof buildContextRequestSchema>

/** One packed section; `key` is 'task' | 'role' | 'criteria' | 'memory:<id>' | 'previousHandoff'. */
export const contextPartSchema = z.strictObject({
  key: z.string(),
  /** Rendered section text including its markdown header. */
  content: z.string(),
  chars: z.number().int().nonnegative(),
})
export type ContextPart = z.infer<typeof contextPartSchema>

export const builtContextSchema = z.strictObject({
  workspaceId: z.string(),
  taskId: z.string().optional(),
  role: z.string().optional(),
  budgetChars: z.number().int().min(1),
  /** Character length of the assembled `content` (never exceeds `budgetChars`). */
  totalChars: z.number().int().nonnegative(),
  /** How many candidate sections were dropped because they did not fit the budget. */
  omittedCount: z.number().int().nonnegative(),
  /** Included sections in assembly order. */
  parts: z.array(contextPartSchema),
  /** The final packed context text — the only context an Agent Adapter receives. */
  content: z.string(),
})
export type BuiltContext = z.infer<typeof builtContextSchema>
