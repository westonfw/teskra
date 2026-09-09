import { z } from 'zod'

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
