import { z } from 'zod'

import { publicAppErrorSchema } from './error'

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
  name: z.string().min(1).nullable(),
})
export type SetDefaultWslDistributionRequest = z.infer<
  typeof setDefaultWslDistributionRequestSchema
>

export const requireRuntimePortRequestSchema = z.strictObject({
  name: futureRuntimePortSchema,
})
export type RequireRuntimePortRequest = z.infer<typeof requireRuntimePortRequestSchema>
