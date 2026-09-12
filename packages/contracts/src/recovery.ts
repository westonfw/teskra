import { z } from 'zod'

import { ipcIdSchema } from './limits'

/**
 * TASK-070 Recovery Center. The Main-side RecoveryCenterService aggregates the
 * five recoverable problem categories; every issue carries one suggested
 * action — Resume (restore an interrupted Run), Repair (re-validate / discard
 * a broken Worktree), or Inspect (jump to the owning surface for details).
 */
export const RECOVERY_ISSUE_KINDS = [
  'interrupted_run',
  'broken_worktree',
  'dirty_worktree',
  'conflict',
  'stale_process',
] as const
export const recoveryIssueKindSchema = z.enum(RECOVERY_ISSUE_KINDS)
export type RecoveryIssueKind = z.infer<typeof recoveryIssueKindSchema>

export const RECOVERY_ACTIONS = ['resume', 'repair', 'inspect'] as const
export const recoveryActionSchema = z.enum(RECOVERY_ACTIONS)
export type RecoveryAction = z.infer<typeof recoveryActionSchema>

export const recoveryIssueSchema = z.strictObject({
  /** Stable per-scan identifier, e.g. `interrupted_run:<runId>`. */
  id: z.string().min(1),
  kind: recoveryIssueKindSchema,
  summary: z.string().min(1),
  detail: z.string().min(1).optional(),
  suggestedAction: recoveryActionSchema,
  workspaceId: z.string().min(1),
  runId: z.string().min(1).optional(),
  worktreeId: z.string().min(1).optional(),
})
export type RecoveryIssue = z.infer<typeof recoveryIssueSchema>

export const recoveryReportSchema = z.strictObject({
  generatedAt: z.string().datetime(),
  workspaceId: z.string().min(1).optional(),
  issues: z.array(recoveryIssueSchema),
})
export type RecoveryReport = z.infer<typeof recoveryReportSchema>

/** Without a workspaceId the report is intentionally empty. */
export const listRecoveryIssuesRequestSchema = z.strictObject({
  workspaceId: ipcIdSchema.optional(),
})
export type ListRecoveryIssuesRequest = z.infer<typeof listRecoveryIssuesRequestSchema>
