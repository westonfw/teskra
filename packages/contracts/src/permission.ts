import { z } from 'zod'

import {
  agentRoleSchema,
  approvalModeSchema,
  teskraPermissionProfileSchema,
} from './agent'

/**
 * ADR-0002 / TASK-065 — Permission contracts.
 *
 * There is NO pre-execution interception: Teskra is a PTY host, not a syscall
 * gateway. Rules are policy input that is projected onto each Agent CLI's own
 * mechanism before launch (TASK-077); audit entries are recorded AFTER a
 * command was recognized in the output stream — `detectedAt` means "recognized
 * at", never "blocked at".
 */

/** plan §139.1 `permission_rules.action`. */
export const PERMISSION_ACTIONS = ['allow', 'deny', 'ask', 'audit'] as const
export const permissionActionSchema = z.enum(PERMISSION_ACTIONS)
export type PermissionAction = z.infer<typeof permissionActionSchema>

/** plan §139.1 `permission_rules.scope`. */
export const PERMISSION_SCOPES = ['once', 'session', 'persistent'] as const
export const permissionScopeSchema = z.enum(PERMISSION_SCOPES)
export type PermissionScope = z.infer<typeof permissionScopeSchema>

/** Public projection of plan §139.1 `permission_rules`; safe to return over IPC. */
export const permissionRuleSchema = z.strictObject({
  id: z.string().min(1),
  /** Absent = global rule. */
  workspaceId: z.string().min(1).optional(),
  /** Absent = applies to every Agent. */
  agentType: z.string().min(1).optional(),
  commandPattern: z.string().min(1),
  riskLevel: z.string().min(1).optional(),
  action: permissionActionSchema,
  scope: permissionScopeSchema,
  createdAt: z.string().datetime(),
})
export type PermissionRule = z.infer<typeof permissionRuleSchema>

/**
 * Public projection of plan §139.1 `permission_audit`. `detectedAt` is the
 * time the command was recognized in the PTY output stream (post-hoc) — the
 * command had already run by then.
 */
export const permissionAuditEntrySchema = z.strictObject({
  id: z.number().int(),
  runId: z.string().min(1),
  command: z.string().min(1),
  cwd: z.string().optional(),
  riskLevel: z.string().min(1),
  matchedRuleId: z.string().min(1).optional(),
  detectedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
})
export type PermissionAuditEntry = z.infer<typeof permissionAuditEntrySchema>

export const listPermissionRulesRequestSchema = z.strictObject({
  /** When set, global rules plus this workspace's rules are returned. */
  workspaceId: z.string().min(1).optional(),
})
export type ListPermissionRulesRequest = z.infer<typeof listPermissionRulesRequestSchema>

export const createPermissionRuleRequestSchema = z.strictObject({
  commandPattern: z.string().trim().min(1),
  action: permissionActionSchema,
  scope: permissionScopeSchema,
  workspaceId: z.string().min(1).optional(),
  agentType: z.string().min(1).optional(),
  riskLevel: z.string().min(1).optional(),
})
export type CreatePermissionRuleRequest = z.infer<typeof createPermissionRuleRequestSchema>

export const updatePermissionRuleRequestSchema = z.strictObject({
  ruleId: z.string().min(1),
  commandPattern: z.string().trim().min(1).optional(),
  action: permissionActionSchema.optional(),
  scope: permissionScopeSchema.optional(),
  /** null clears the stored risk level. */
  riskLevel: z.string().min(1).nullable().optional(),
})
export type UpdatePermissionRuleRequest = z.infer<typeof updatePermissionRuleRequestSchema>

export const permissionRuleIdRequestSchema = z.strictObject({ ruleId: z.string().min(1) })
export type PermissionRuleIdRequest = z.infer<typeof permissionRuleIdRequestSchema>

export const listPermissionAuditRequestSchema = z.strictObject({
  runId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  riskLevel: z.string().min(1).optional(),
  limit: z.number().int().positive().max(1000).optional(),
})
export type ListPermissionAuditRequest = z.infer<typeof listPermissionAuditRequestSchema>

export const resolvePermissionProfileRequestSchema = z.strictObject({
  agentType: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  role: agentRoleSchema.optional(),
  /** Defaults to 'manual' when only the rule merge is of interest (Settings preview). */
  approvalMode: approvalModeSchema.optional(),
})
export type ResolvePermissionProfileRequest = z.infer<typeof resolvePermissionProfileRequestSchema>

/**
 * A rule that does not translate into the projected CLI policy verbatim.
 * The primary case is the ADR-0002 `ask` downgrade: only `native` Agents have
 * their own approval prompt, so `ask` on any other Agent degrades to
 * audit-only and the UI must say so instead of implying enforcement.
 */
export const permissionNoticeSchema = z.strictObject({
  ruleId: z.string().min(1),
  action: permissionActionSchema,
  reason: z.string().min(1),
})
export type PermissionNotice = z.infer<typeof permissionNoticeSchema>

export const resolvedPermissionProfileSchema = z.strictObject({
  profile: teskraPermissionProfileSchema,
  notices: z.array(permissionNoticeSchema),
})
export type ResolvedPermissionProfile = z.infer<typeof resolvedPermissionProfileSchema>

/**
 * TASK-066 approval decisions. ADR-0002 honesty constraint: these decisions
 * are policy input only — they are stored (persistent rules) or held for the
 * app session and consumed by the NEXT Run's policy projection. Nothing here
 * gates a command that is already running.
 */
export const PERMISSION_DECISIONS = ['allow-once', 'allow-session', 'always-allow', 'deny'] as const
export const permissionDecisionSchema = z.enum(PERMISSION_DECISIONS)
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>

export const resolvePermissionDecisionRequestSchema = z.strictObject({
  agentType: z.string().min(1),
  commandPattern: z.string().trim().min(1),
  decision: permissionDecisionSchema,
  workspaceId: z.string().min(1).optional(),
  /** Run the decision originated from; carried into the permission.resolved event. */
  runId: z.string().min(1).optional(),
})
export type ResolvePermissionDecisionRequest = z.infer<
  typeof resolvePermissionDecisionRequestSchema
>

export const permissionDecisionResultSchema = z.strictObject({
  decision: permissionDecisionSchema,
  /** Where the decision landed: a persisted rule or the in-memory session state. */
  persistedAs: z.enum(['rule', 'session', 'once']),
  rule: permissionRuleSchema.optional(),
})
export type PermissionDecisionResult = z.infer<typeof permissionDecisionResultSchema>
