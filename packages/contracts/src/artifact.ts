import { z } from 'zod'

/** §139.1 `artifacts.type` (line 5410) — 七种. */
export const ARTIFACT_TYPES = [
  'plan',
  'implementation',
  'review',
  'test-result',
  'diff',
  'decision',
  'handoff',
] as const
export const artifactTypeSchema = z.enum(ARTIFACT_TYPES)
export type ArtifactType = z.infer<typeof artifactTypeSchema>
