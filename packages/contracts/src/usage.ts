import { z } from 'zod'

import { agentRunIdRequestSchema } from './agent'
import { ipcIdSchema } from './limits'

/**
 * TASK-124 (teskra-tasks.md; Milestone 25 design doc §7; DDL: plan §139.1
 * migration 018) — per-run usage accounting accumulated from the structured
 * output stream's `usage` observations (ADR-0013).
 *
 * One row per Run. Claude reports usage once with its `result`, Codex on every
 * `turn.completed`; both accumulate into the same row. `costUsdMicros` is only
 * ever the provider-reported cost — Teskra NEVER estimates cost from a price
 * table, so a run whose stream carries no cost keeps NULL and the UI shows
 * "未报告" instead of 0.
 *
 * Usage is display-only: it is NOT an input to rate-limit / quota decisions
 * (that classification belongs to the ADR-0010 FailureClassifier).
 */

/** The structured-stream protocols that can produce usage observations. */
export const USAGE_SOURCES = ['claude-stream-json', 'codex-exec-json'] as const
export const usageSourceSchema = z.enum(USAGE_SOURCES)
export type UsageSource = z.infer<typeof usageSourceSchema>

const tokenCountSchema = z.number().int().nonnegative()

/** One `agent_run_usage` row (every token column defaults to 0, CHECK >= 0). */
export const agentRunUsageSchema = z.strictObject({
  runId: z.string().min(1),
  source: usageSourceSchema,
  model: z.string().min(1).optional(),
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  cacheReadTokens: tokenCountSchema,
  cacheWriteTokens: tokenCountSchema,
  /** Micros of USD; absent = the provider never reported a cost. */
  costUsdMicros: z.number().int().nonnegative().optional(),
  /** How many usage observations accumulated into this row. */
  turns: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
})
export type AgentRunUsage = z.infer<typeof agentRunUsageSchema>

/**
 * One aggregation bucket of `teskra:usage:summary`. The dimensions come from
 * joining `agent_runs` (workspace / agentType / accountProfileId are never
 * duplicated onto the usage table); `accountProfileId` is absent for runs that
 * carried no account profile pin.
 */
export const usageSummaryBucketSchema = z.strictObject({
  workspaceId: z.string().min(1),
  agentType: z.string().min(1),
  accountProfileId: z.string().min(1).optional(),
  runs: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  cacheReadTokens: tokenCountSchema,
  cacheWriteTokens: tokenCountSchema,
  /** SUM over reporting runs only; absent when no run in the bucket reported a cost. */
  costUsdMicros: z.number().int().nonnegative().optional(),
})
export type UsageSummaryBucket = z.infer<typeof usageSummaryBucketSchema>

/** teskra:usage:summary — all filters optional and combinable; `since` bounds updated_at. */
export const summarizeUsageRequestSchema = z.strictObject({
  workspaceId: ipcIdSchema.optional(),
  accountProfileId: ipcIdSchema.optional(),
  agentType: z.string().min(1).optional(),
  /** ISO-8601 UTC; only usage rows updated at or after this instant count. */
  since: z.string().datetime(),
})
export type SummarizeUsageRequest = z.infer<typeof summarizeUsageRequestSchema>

/** teskra:usage:get-by-run — one run's accumulated usage row (null = none yet). */
export const getRunUsageRequestSchema = agentRunIdRequestSchema
export type GetRunUsageRequest = z.infer<typeof getRunUsageRequestSchema>
