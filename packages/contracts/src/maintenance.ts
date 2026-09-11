import { z } from 'zod'

import { retentionConfigSchema } from './config'

/**
 * RetentionService contracts (TASK-069, teskra-tasks.md; plan §135).
 *
 * Three GC categories, each gated by a `retention` config threshold:
 *
 * - merged-worktree: worktrees in state `merged` older than
 *   `mergedWorktreeDays` lose their directory, DB record, and branch — the
 *   branch only after a fresh `git merge-base --is-ancestor` double check;
 *   unmerged branches are NEVER deleted.
 * - run-logs: terminal runs older than `completedRunLogsDays` lose the
 *   volatile log files (events.jsonl / terminal.log); the manifest, handoff,
 *   diff, and artifacts stay.
 * - discarded-run: runs whose worktree was discarded, older than
 *   `discardedRunDays`, lose the whole run directory and — only when no
 *   handoff DB record exists — the agent_runs row. Handoff records are kept
 *   by default (post-hoc audit value, ADR-0002).
 *
 * plan() is the dry-run preview; run() executes and supports cancellation
 * (one item at a time, checked between items). Every executed item produces
 * an audit entry: what was deleted, why, and when.
 */

export const RETENTION_ITEM_KINDS = ['merged-worktree', 'run-logs', 'discarded-run'] as const
export const retentionItemKindSchema = z.enum(RETENTION_ITEM_KINDS)
export type RetentionItemKind = z.infer<typeof retentionItemKindSchema>

export const retentionPlanItemSchema = z.strictObject({
  kind: retentionItemKindSchema,
  workspaceId: z.string().min(1),
  worktreeId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  /** Host-side directory affected by the cleanup, when one exists. */
  path: z.string().min(1).optional(),
  ageDays: z.number().int().min(0),
  /** Human-readable justification: which threshold the item exceeded. */
  reason: z.string().min(1),
})
export type RetentionPlanItem = z.infer<typeof retentionPlanItemSchema>

export const retentionPlanRequestSchema = z.strictObject({
  /** Restricts the scan to one workspace; absent = all workspaces. */
  workspaceId: z.string().min(1).optional(),
})
export type RetentionPlanRequest = z.infer<typeof retentionPlanRequestSchema>

/** The dry-run result: what run() would delete, with the policy applied. */
export const retentionPlanSchema = z.strictObject({
  generatedAt: z.string(),
  policy: retentionConfigSchema,
  items: z.array(retentionPlanItemSchema),
})
export type RetentionPlan = z.infer<typeof retentionPlanSchema>

export const retentionRunRequestSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** Defaults false. True = compute the plan and report it without deleting. */
  dryRun: z.boolean().optional(),
})
export type RetentionRunRequest = z.infer<typeof retentionRunRequestSchema>

export const RETENTION_AUDIT_ACTIONS = ['deleted', 'skipped', 'failed'] as const
export const retentionAuditActionSchema = z.enum(RETENTION_AUDIT_ACTIONS)
export type RetentionAuditAction = z.infer<typeof retentionAuditActionSchema>

/** One audited decision per planned item (deletion, refusal, or failure). */
export const retentionAuditEntrySchema = z.strictObject({
  item: retentionPlanItemSchema,
  action: retentionAuditActionSchema,
  detail: z.string().optional(),
  at: z.string(),
})
export type RetentionAuditEntry = z.infer<typeof retentionAuditEntrySchema>

export const retentionReportSchema = z.strictObject({
  startedAt: z.string(),
  finishedAt: z.string(),
  dryRun: z.boolean(),
  /** True when cancellation stopped the run before all items were processed. */
  cancelled: z.boolean(),
  policy: retentionConfigSchema,
  entries: z.array(retentionAuditEntrySchema),
})
export type RetentionReport = z.infer<typeof retentionReportSchema>
