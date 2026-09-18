import { z } from 'zod'

import { IPC_TEXT_MAX, ipcIdSchema, ipcNameSchema, ipcPathSchema } from './limits'

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

/**
 * TASK-088: a persisted secret env entry is a Credential Store reference, not
 * the value. The reference is an opaque store key (e.g.
 * `workspace/<workspaceId>/<ENV_KEY>`); the plaintext only exists inside the
 * Credential Store and in the launched process's environment.
 */
export const workspaceSecretRefSchema = z.strictObject({
  secretRef: z.string().min(1),
})
export type WorkspaceSecretRef = z.infer<typeof workspaceSecretRefSchema>

export const workspaceEnvValueSchema = z.union([z.string(), workspaceSecretRefSchema])
export type WorkspaceEnvValue = z.infer<typeof workspaceEnvValueSchema>

/**
 * TASK-118 Workspace Trust (design doc §43, code-review P0-3). Repo-local
 * content (`<repo>/.teskra/` workflows / prompts / config) can carry
 * executable commands, so it only loads for workspaces the user explicitly
 * trusted. Everything else stays `restricted` — the safe default, mirroring
 * VS Code Workspace Trust.
 */
export const WORKSPACE_TRUST_LEVELS = ['trusted', 'restricted'] as const
export const workspaceTrustLevelSchema = z.enum(WORKSPACE_TRUST_LEVELS)
export type WorkspaceTrustLevel = z.infer<typeof workspaceTrustLevelSchema>
export const DEFAULT_WORKSPACE_TRUST_LEVEL: WorkspaceTrustLevel = 'restricted'

export function isWorkspaceSecretRef(value: WorkspaceEnvValue): value is WorkspaceSecretRef {
  return typeof value !== 'string'
}

/** Fields mirror the §139.1 `workspaces` table; timestamps are ISO-8601 UTC text. */
export const workspaceSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  runtime: workspaceRuntimeRefSchema,
  path: z.string(),
  gitRoot: z.string().optional(),
  defaultBranch: z.string().optional(),
  /** Non-sensitive values are plain strings; secrets are Credential Store refs. */
  env: z.record(z.string(), workspaceEnvValueSchema).optional(),
  trustLevel: workspaceTrustLevelSchema,
  lastOpenedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Workspace = z.infer<typeof workspaceSchema>

const workspaceInputFields = {
  runtime: workspaceRuntimeRefSchema,
  path: ipcPathSchema,
  gitRoot: ipcPathSchema.optional(),
  defaultBranch: ipcNameSchema.optional(),
  /** Callers send plaintext; the Main process diverts secrets to the Credential Store. */
  env: z.record(z.string(), z.string().max(IPC_TEXT_MAX)).optional(),
}

export const createWorkspaceRequestSchema = z.strictObject({
  name: ipcNameSchema,
  ...workspaceInputFields,
})
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>

export const openWorkspaceRequestSchema = z.strictObject({
  name: ipcNameSchema.optional(),
  ...workspaceInputFields,
})
export type OpenWorkspaceRequest = z.infer<typeof openWorkspaceRequestSchema>

export const workspaceIdRequestSchema = z.strictObject({ id: ipcIdSchema })
export type WorkspaceIdRequest = z.infer<typeof workspaceIdRequestSchema>

/** TASK-118: flips the workspace trust level (WorkspacePort.updateTrust). */
export const updateWorkspaceTrustRequestSchema = z.strictObject({
  id: ipcIdSchema,
  trustLevel: workspaceTrustLevelSchema,
})
export type UpdateWorkspaceTrustRequest = z.infer<typeof updateWorkspaceTrustRequestSchema>

export const listRecentWorkspacesRequestSchema = z.strictObject({
  limit: z.number().int().positive().max(100).optional(),
})
export type ListRecentWorkspacesRequest = z.infer<typeof listRecentWorkspacesRequestSchema>

export const selectWorkspaceDirectoryRequestSchema = z.strictObject({
  runtime: workspaceRuntimeRefSchema,
})
export type SelectWorkspaceDirectoryRequest = z.infer<typeof selectWorkspaceDirectoryRequestSchema>

export const workspaceValidationSchema = z.strictObject({ exists: z.boolean().nullable() })
export type WorkspaceValidationResult = z.infer<typeof workspaceValidationSchema>
