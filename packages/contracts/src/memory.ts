import { z } from 'zod'

/**
 * TASK-067 Workspace Memory domain (plan §45/§46, §139.1 `memories` table).
 *
 * Memories are bound to a Workspace and come from two sources:
 *
 * - database rows (`memories` table) — full manual CRUD, `source` is
 *   'manual' | 'run:<runId>' (free-form by design);
 * - repo-local markdown files under `<repo>/.teskra/memory/` (committable,
 *   team-shared) — read-only from the app's perspective; their records carry
 *   ids and sources of the form `file:<name>` so the UI can render them as
 *   immutable.
 *
 * Secret hygiene: memory content is validated on write against the TASK-004
 * redact secret patterns — a memory that looks like it contains a token is
 * refused, never stored.
 */

/** §139.1 `memories.type` (line 5434) — 七种. */
export const MEMORY_TYPES = [
  'architecture',
  'convention',
  'decision',
  'command',
  'known_issue',
  'preference',
  'summary',
] as const
export const memoryTypeSchema = z.enum(MEMORY_TYPES)
export type MemoryType = z.infer<typeof memoryTypeSchema>

export const memoryRecordSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  type: memoryTypeSchema,
  content: z.string(),
  /** 'manual' | 'file:<name>' | 'run:<runId>' — free-form by design. */
  source: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Memory = z.infer<typeof memoryRecordSchema>

export const listMemoriesRequestSchema = z.strictObject({
  workspaceId: z.string().min(1),
  type: memoryTypeSchema.optional(),
})
export type ListMemoriesRequest = z.infer<typeof listMemoriesRequestSchema>

export const memoryIdRequestSchema = z.strictObject({
  id: z.string().min(1),
})
export type MemoryIdRequest = z.infer<typeof memoryIdRequestSchema>

export const createMemoryRequestSchema = z.strictObject({
  workspaceId: z.string().min(1),
  type: memoryTypeSchema,
  content: z.string().min(1),
})
export type CreateMemoryRequest = z.infer<typeof createMemoryRequestSchema>

export const updateMemoryRequestSchema = z.strictObject({
  id: z.string().min(1),
  type: memoryTypeSchema.optional(),
  content: z.string().min(1).optional(),
})
export type UpdateMemoryRequest = z.infer<typeof updateMemoryRequestSchema>
