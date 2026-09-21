import { z } from 'zod'

import { publicAppErrorSchema } from './error'
import { ipcNameSchema } from './limits'

export const systemInfoSchema = z.strictObject({
  appVersion: z.string().min(1),
  runtimeVersion: z.string().min(1),
})
export type SystemInfo = z.infer<typeof systemInfoSchema>

export const systemPathsSchema = z.strictObject({
  dataDirectory: z.string().min(1),
  logDirectory: z.string().min(1),
  databaseFile: z.string().min(1),
})
export type SystemPaths = z.infer<typeof systemPathsSchema>

export const SYSTEM_DIRECTORY_KINDS = ['data', 'logs'] as const
export const systemDirectoryKindSchema = z.enum(SYSTEM_DIRECTORY_KINDS)
export type SystemDirectoryKind = z.infer<typeof systemDirectoryKindSchema>

export const openSystemDirectoryRequestSchema = z.strictObject({
  kind: systemDirectoryKindSchema,
})
export type OpenSystemDirectoryRequest = z.infer<typeof openSystemDirectoryRequestSchema>

/**
 * Opens a URL in the system browser. Zod guarantees a parseable absolute URL;
 * Main additionally restricts the scheme to https: before calling
 * shell.openExternal (never file:, javascript:, or OS handler schemes).
 */
export const openExternalRequestSchema = z.strictObject({
  url: z.string().url(),
})
export type OpenExternalRequest = z.infer<typeof openExternalRequestSchema>

export const systemHealthSchema = z.strictObject({
  databaseAvailable: z.boolean(),
  wslAvailable: z.boolean(),
  issues: z.array(publicAppErrorSchema),
})
export type SystemHealth = z.infer<typeof systemHealthSchema>

export const FUTURE_RUNTIME_PORTS = ['task', 'agent', 'git', 'worktree', 'workflow'] as const
export const futureRuntimePortSchema = z.enum(FUTURE_RUNTIME_PORTS)
export type FutureRuntimePortName = z.infer<typeof futureRuntimePortSchema>

export const setDefaultWslDistributionRequestSchema = z.strictObject({
  name: ipcNameSchema.nullable(),
})
export type SetDefaultWslDistributionRequest = z.infer<
  typeof setDefaultWslDistributionRequestSchema
>

export const requireRuntimePortRequestSchema = z.strictObject({
  name: futureRuntimePortSchema,
})
export type RequireRuntimePortRequest = z.infer<typeof requireRuntimePortRequestSchema>
