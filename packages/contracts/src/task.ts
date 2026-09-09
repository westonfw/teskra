import { z } from 'zod'

/**
 * plan §138 TaskStatus 八态 — values mirror §139.1 `tasks.status` (line 5221).
 */
export const TASK_STATUSES = [
  'draft',
  'ready',
  'running',
  'needs_review',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const
export const taskStatusSchema = z.enum(TASK_STATUSES)
export type TaskStatus = z.infer<typeof taskStatusSchema>

/** Fields mirror the §139.1 `tasks` table; timestamps are ISO-8601 UTC text. */
export const taskSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: taskStatusSchema,
  archivedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Task = z.infer<typeof taskSchema>
