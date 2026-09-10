import { z } from 'zod'

/** §139.1 `worktrees.state` (line 5240, §132 WorktreeState 八态). */
export const WORKTREE_STATES = [
  'creating',
  'ready',
  'dirty',
  'conflict',
  'merged',
  'discarded',
  'missing',
  'orphaned',
] as const
export const worktreeStateSchema = z.enum(WORKTREE_STATES)
export type WorktreeState = z.infer<typeof worktreeStateSchema>

/** §139.1 `worktrees.isolation` (line 5241). */
export const WORKTREE_ISOLATIONS = [
  'worktree',
  'shared-readonly',
  'worktree-readonly',
  'disposable-snapshot',
] as const
export const worktreeIsolationSchema = z.enum(WORKTREE_ISOLATIONS)
export type WorktreeIsolation = z.infer<typeof worktreeIsolationSchema>

/**
 * Worktree record crossing IPC (TASK-043). Fields mirror the §139.1
 * `worktrees` table; the Main-side repository validates against its own
 * stricter copy (ISO-8601 UTC timestamps with ms precision).
 */
export const worktreeSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  runId: z.string().optional(),
  branch: z.string(),
  baseBranch: z.string(),
  path: z.string(),
  state: worktreeStateSchema,
  isolation: worktreeIsolationSchema,
  mergedAt: z.string().datetime().optional(),
  discardedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type Worktree = z.infer<typeof worktreeSchema>

/**
 * TASK-043 branch naming (ADR-0003): `agent/<taskId>/<agentId>/<runId>` when
 * the run belongs to a task, otherwise the fixed fallback `agent/<runId>`.
 */
export const worktreeCreateRequestSchema = z.strictObject({
  workspaceId: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  /** Defaults to the repository's current branch. */
  baseBranch: z.string().min(1).optional(),
  /** Defaults to 'worktree'. */
  isolation: worktreeIsolationSchema.optional(),
})
export type WorktreeCreateRequest = z.infer<typeof worktreeCreateRequestSchema>

export const worktreeListRequestSchema = z.strictObject({
  workspaceId: z.string().min(1),
  state: worktreeStateSchema.optional(),
})
export type WorktreeListRequest = z.infer<typeof worktreeListRequestSchema>

export const worktreeIdRequestSchema = z.strictObject({ worktreeId: z.string().min(1) })
export type WorktreeIdRequest = z.infer<typeof worktreeIdRequestSchema>

/** plan §40. */
export const DIFF_FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed'] as const
export const diffFileStatusSchema = z.enum(DIFF_FILE_STATUSES)
export type DiffFileStatus = z.infer<typeof diffFileStatusSchema>

export const diffFileSchema = z.strictObject({
  path: z.string(),
  status: diffFileStatusSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string(),
})
export type DiffFile = z.infer<typeof diffFileSchema>

export const diffResultSchema = z.strictObject({
  files: z.array(diffFileSchema),
})
export type DiffResult = z.infer<typeof diffResultSchema>

export const gitWorkspaceRequestSchema = z.strictObject({ workspaceId: z.string().min(1) })
export type GitWorkspaceRequest = z.infer<typeof gitWorkspaceRequestSchema>

export const gitOpenFileRequestSchema = gitWorkspaceRequestSchema.extend({
  path: z.string().min(1),
})
export type GitOpenFileRequest = z.infer<typeof gitOpenFileRequestSchema>

export const gitStatusEntrySchema = z.strictObject({
  path: z.string(),
  code: z.string().min(1),
})
export type GitStatusEntry = z.infer<typeof gitStatusEntrySchema>

export const gitStatusSchema = z.strictObject({
  branch: z.string().optional(),
  upstream: z.string().optional(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  clean: z.boolean(),
  entries: z.array(gitStatusEntrySchema),
})
export type GitStatus = z.infer<typeof gitStatusSchema>

export const gitBranchSchema = z.strictObject({
  current: z.string().optional(),
  detached: z.boolean(),
  branches: z.array(z.string()),
})
export type GitBranch = z.infer<typeof gitBranchSchema>

export const gitDiffRequestSchema = gitWorkspaceRequestSchema.extend({
  staged: z.boolean().optional(),
  path: z.string().min(1).optional(),
})
export type GitDiffRequest = z.infer<typeof gitDiffRequestSchema>

export const gitRawDiffSchema = z.strictObject({ patch: z.string() })
export type GitRawDiff = z.infer<typeof gitRawDiffSchema>

export const gitLogRequestSchema = gitWorkspaceRequestSchema.extend({
  limit: z.number().int().positive().max(200).optional(),
})
export type GitLogRequest = z.infer<typeof gitLogRequestSchema>

export const gitCommitSchema = z.strictObject({
  hash: z.string().min(1),
  shortHash: z.string().min(1),
  author: z.string(),
  authoredAt: z.string(),
  subject: z.string(),
})
export type GitCommit = z.infer<typeof gitCommitSchema>

export const gitCommitRequestSchema = gitWorkspaceRequestSchema.extend({
  message: z.string().trim().min(1),
  all: z.boolean().optional(),
})
export type GitCommitRequest = z.infer<typeof gitCommitRequestSchema>

export const gitCommitResultSchema = z.strictObject({
  hash: z.string().min(1),
  output: z.string(),
})
export type GitCommitResult = z.infer<typeof gitCommitResultSchema>
