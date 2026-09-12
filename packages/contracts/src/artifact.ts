import { z } from 'zod'

import { IPC_NAME_MAX, ipcContentSchema, ipcIdSchema, ipcPathSchema } from './limits'

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

/** Opaque metadata bag stored in `artifacts.metadata_json`. */
export const artifactMetadataSchema = z.record(z.string(), z.unknown())
export type ArtifactMetadata = z.infer<typeof artifactMetadataSchema>

/**
 * TASK-050 — the canonical `artifacts` record (§139.1, 004_artifacts_memory.sql
 * lines 5406–5417). The payload is exactly one of three forms: inline `content`
 * text, a `filePath` relative to the owning Run's artifact directory, or a
 * `metadata` JSON record. `createdAt` is a plain string here; the Repository
 * layer re-validates it as strict ISO-8601 UTC.
 */
export const artifactSchema = z.strictObject({
  id: z.string(),
  taskId: z.string(),
  runId: z.string().optional(),
  type: artifactTypeSchema,
  name: z.string(),
  content: z.string().optional(),
  filePath: z.string().optional(),
  metadata: artifactMetadataSchema.optional(),
  createdAt: z.string(),
})
export type Artifact = z.infer<typeof artifactSchema>

/**
 * Registers an Artifact against a Task and optionally the Run that produced
 * it. Exactly one payload form must be given: `content` (inline text),
 * `filePath` (relative to the Run's artifact directory), or `metadata`.
 */
export const recordArtifactRequestSchema = z
  .strictObject({
    taskId: ipcIdSchema,
    runId: ipcIdSchema.optional(),
    type: artifactTypeSchema,
    name: z.string().trim().min(1).max(IPC_NAME_MAX),
    content: ipcContentSchema.optional(),
    filePath: ipcPathSchema.optional(),
    metadata: artifactMetadataSchema.optional(),
  })
  .refine(
    ({ content, filePath, metadata }) =>
      [content, filePath, metadata].filter((value) => value !== undefined).length === 1,
    { message: 'Exactly one of content / filePath / metadata must be provided.' },
  )
export type RecordArtifactRequest = z.infer<typeof recordArtifactRequestSchema>

/** At least one of `taskId` / `runId` narrows the listing. */
export const listArtifactsRequestSchema = z
  .strictObject({
    taskId: ipcIdSchema.optional(),
    runId: ipcIdSchema.optional(),
    type: artifactTypeSchema.optional(),
  })
  .refine(({ taskId, runId }) => taskId !== undefined || runId !== undefined, {
    message: 'taskId or runId is required.',
  })
export type ListArtifactsRequest = z.infer<typeof listArtifactsRequestSchema>

export const artifactIdRequestSchema = z.strictObject({
  artifactId: ipcIdSchema,
})
export type ArtifactIdRequest = z.infer<typeof artifactIdRequestSchema>

/** Scans the Run's artifact directory and registers not-yet-indexed files. */
export const scanRunArtifactsRequestSchema = z.strictObject({
  runId: ipcIdSchema,
})
export type ScanRunArtifactsRequest = z.infer<typeof scanRunArtifactsRequestSchema>

/**
 * An Artifact with its payload resolved for display: inline text as-is, file
 * contents read from disk, or metadata serialized as pretty-printed JSON.
 * `truncated` marks file payloads cut off at the read cap.
 */
export const artifactContentSchema = z.strictObject({
  artifact: artifactSchema,
  content: z.string(),
  truncated: z.boolean(),
})
export type ArtifactContent = z.infer<typeof artifactContentSchema>
