import { z } from 'zod'

/**
 * plan §116.1 — values mirror §139.1 `workspaces.runtime_kind` (line 5200).
 */
export const RUNTIME_KINDS = ['windows', 'wsl', 'ssh', 'container'] as const
export const runtimeKindSchema = z.enum(RUNTIME_KINDS)
export type RuntimeKind = z.infer<typeof runtimeKindSchema>

/** plan §116.1. Which optional field is set depends on `kind`. */
export const workspaceRuntimeRefSchema = z.strictObject({
  kind: runtimeKindSchema,
  distro: z.string().optional(),
  host: z.string().optional(),
  containerId: z.string().optional(),
})
export type WorkspaceRuntimeRef = z.infer<typeof workspaceRuntimeRefSchema>

/** Fields mirror the §139.1 `workspaces` table; timestamps are ISO-8601 UTC text. */
export const workspaceSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  runtime: workspaceRuntimeRefSchema,
  path: z.string(),
  gitRoot: z.string().optional(),
  defaultBranch: z.string().optional(),
  /** Non-sensitive env vars only; secrets go through the Credential Store. */
  env: z.record(z.string(), z.string()).optional(),
  lastOpenedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Workspace = z.infer<typeof workspaceSchema>
