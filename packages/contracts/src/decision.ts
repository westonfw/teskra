import { z } from 'zod'

import { mergePreflightBlockerSchema } from './git'
import { ipcIdSchema, ipcTextSchema } from './limits'

/**
 * PendingDecision contracts (TASK-128, teskra-tasks.md; ADR-0014; Milestone 25
 * design doc §9.1; DDL: plan §139.1 migration 019).
 *
 * Every moment that needs a human decision — shell confirmation, agent
 * blocker, stalled run, merge blocked, rate limit, degraded handoff — lands in
 * the same persisted inbox (`pending_decisions`). The DecisionService only
 * opens, resolves, expires and cancels rows; the action behind a resolution is
 * executed by the source module subscribed through `onResolved(kind, handler)`,
 * never by the service itself (ADR-0014 §3).
 */

export const DECISION_KINDS = [
  'shell_confirmation',
  'agent_blocker',
  'stalled_run',
  'merge_blocked',
  'rate_limit',
  'handoff_degraded',
] as const
export const decisionKindSchema = z.enum(DECISION_KINDS)
export type DecisionKind = z.infer<typeof decisionKindSchema>

export const DECISION_STATUSES = ['open', 'resolved', 'expired', 'cancelled'] as const
export const decisionStatusSchema = z.enum(DECISION_STATUSES)
export type DecisionStatus = z.infer<typeof decisionStatusSchema>

export const DECISION_SEVERITIES = ['info', 'warning', 'blocking'] as const
export const decisionSeveritySchema = z.enum(DECISION_SEVERITIES)
export type DecisionSeverity = z.infer<typeof decisionSeveritySchema>

/**
 * One selectable answer. There is deliberately NO "remember my choice" /
 * "always allow" field (ADR-0014 §7, code-review P1-6): a shell confirmation
 * approves exactly one execution. The schema is the enforcement point — any
 * payload carrying such a flag fails `.strictObject` validation.
 */
// Storage schema (persisted in options_json) — unbounded per limits.ts;
// the resolve IPC request bounds the chosen optionId with ipcIdSchema.
export const decisionOptionSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Dangerous options (e.g. force_merge) get a second confirmation in the UI. */
  danger: z.boolean().optional(),
})
export type DecisionOption = z.infer<typeof decisionOptionSchema>

/**
 * `detail_json` is a discriminated union on `kind` (design doc §9.1): each
 * kind persists exactly the context its source module and the Inbox UI need.
 * The discriminator is embedded in the stored JSON so a row's detail is
 * self-describing even before it is joined with the `kind` column.
 */
export const shellConfirmationDecisionDetailSchema = z.strictObject({
  kind: z.literal('shell_confirmation'),
  /** The complete command line exactly as it will execute (TASK-118). */
  command: z.string().min(1),
  cwd: z.string().min(1),
})
export const agentBlockerDecisionDetailSchema = z.strictObject({
  kind: z.literal('agent_blocker'),
  /** The blocker / question text reported through the progress file (ADR-0012). */
  text: z.string().min(1),
})
export const stalledRunDecisionDetailSchema = z.strictObject({
  kind: z.literal('stalled_run'),
  /** How long the run had been silent when the watchdog opened the decision. */
  silentForMs: z.number().int().min(0),
})
export const mergeBlockedDecisionDetailSchema = z.strictObject({
  kind: z.literal('merge_blocked'),
  /** The failed preflight checks; every blocker here is overridable (hard blockers never open a decision). */
  blockers: z.array(mergePreflightBlockerSchema).min(1),
})
export const rateLimitDecisionDetailSchema = z.strictObject({
  kind: z.literal('rate_limit'),
  message: z.string().min(1),
  /** Provider-reported reset time when known (ADR-0010). */
  limitedUntil: z.string().datetime().optional(),
  accountProfileId: z.string().min(1).optional(),
})
export const handoffDegradedDecisionDetailSchema = z.strictObject({
  kind: z.literal('handoff_degraded'),
  /** Where the unvalidated raw handoff text was preserved (ADR-0004). */
  rawPath: z.string().min(1),
  /** The Zod issues that made the handoff `degraded`, when available. */
  issues: z.array(z.string()).optional(),
})
export const decisionDetailSchema = z.discriminatedUnion('kind', [
  shellConfirmationDecisionDetailSchema,
  agentBlockerDecisionDetailSchema,
  stalledRunDecisionDetailSchema,
  mergeBlockedDecisionDetailSchema,
  rateLimitDecisionDetailSchema,
  handoffDegradedDecisionDetailSchema,
])
export type DecisionDetail = z.infer<typeof decisionDetailSchema>

export const DECISION_DECIDED_BY = ['user', 'timeout', 'system'] as const
export const decisionDecidedBySchema = z.enum(DECISION_DECIDED_BY)
export type DecisionDecidedBy = z.infer<typeof decisionDecidedBySchema>

/**
 * How an `open` decision was closed. `timeout` = expired by the watchdog tick
 * with the kind's default action; `system` = closed without a user (startup
 * reconciliation, source cancellation paths that record a reason).
 */
export const decisionResolutionSchema = z.strictObject({
  optionId: z.string().min(1),
  decidedBy: decisionDecidedBySchema,
  decidedAt: z.string().datetime(),
  note: z.string().optional(),
})
export type DecisionResolution = z.infer<typeof decisionResolutionSchema>

export const pendingDecisionSchema = z
  .strictObject({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    kind: decisionKindSchema,
    status: decisionStatusSchema,
    severity: decisionSeveritySchema,
    /** Source references — ON DELETE SET NULL in the DDL: the audit row survives the source. */
    runId: z.string().min(1).optional(),
    workflowRunId: z.string().min(1).optional(),
    workflowStepId: z.string().min(1).optional(),
    worktreeId: z.string().min(1).optional(),
    /** `${kind}:${sourceId}`; the partial unique index allows one open row per key. */
    dedupeKey: z.string().min(1),
    title: z.string().min(1),
    detail: decisionDetailSchema,
    options: z.array(decisionOptionSchema).min(1),
    resolution: decisionResolutionSchema.optional(),
    /** NULL = never expires (decisions.*TimeoutMs 0, the default). */
    expiresAt: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
    resolvedAt: z.string().datetime().optional(),
  })
  .superRefine((decision, context) => {
    if (decision.detail.kind !== decision.kind) {
      context.addIssue({
        code: 'custom',
        path: ['detail', 'kind'],
        message: 'detail.kind must match the decision kind',
      })
    }
  })
export type PendingDecision = z.infer<typeof pendingDecisionSchema>

/** teskra:decision:list — all filters optional and combinable. */
export const listDecisionsRequestSchema = z.strictObject({
  workspaceId: ipcIdSchema.optional(),
  kind: decisionKindSchema.optional(),
  status: decisionStatusSchema.optional(),
})
export type ListDecisionsRequest = z.infer<typeof listDecisionsRequestSchema>

/** teskra:decision:resolve — the user picked an option (decidedBy is always 'user' over IPC). */
export const resolveDecisionRequestSchema = z.strictObject({
  id: ipcIdSchema,
  optionId: ipcIdSchema,
  note: ipcTextSchema.optional(),
})
export type ResolveDecisionRequest = z.infer<typeof resolveDecisionRequestSchema>
