import { z } from 'zod'

import { IPC_NAME_MAX, ipcIdSchema, ipcTextSchema } from './limits'

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

export const createTaskRequestSchema = z.strictObject({
  workspaceId: ipcIdSchema,
  title: z.string().trim().min(1).max(IPC_NAME_MAX),
  description: ipcTextSchema.optional(),
  status: taskStatusSchema.optional(),
})
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>

export const updateTaskRequestSchema = z
  .strictObject({
    id: ipcIdSchema,
    title: z.string().trim().min(1).max(IPC_NAME_MAX).optional(),
    description: ipcTextSchema.nullable().optional(),
    status: taskStatusSchema.optional(),
  })
  .refine(
    ({ title, description, status }) =>
      title !== undefined || description !== undefined || status !== undefined,
    { message: 'At least one Task field must be updated.' },
  )
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>

export const taskIdRequestSchema = z.strictObject({ id: ipcIdSchema })
export type TaskIdRequest = z.infer<typeof taskIdRequestSchema>

export const archiveTaskRequestSchema = taskIdRequestSchema.extend({ archived: z.boolean() })
export type ArchiveTaskRequest = z.infer<typeof archiveTaskRequestSchema>

export const listTasksRequestSchema = z.strictObject({
  workspaceId: ipcIdSchema,
  status: taskStatusSchema.optional(),
  includeArchived: z.boolean().optional(),
})
export type ListTasksRequest = z.infer<typeof listTasksRequestSchema>
