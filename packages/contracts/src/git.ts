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
