import { z } from 'zod'

/**
 * WSL host capabilities exposed by the system Facade (TASK-011).
 *
 * `systemDefault` is detected from `wsl.exe --status`; `configuredDefault`
 * is Teskra's optional global preference. `effectiveDefault` is the latter
 * when it still exists, otherwise the host default.
 */
export const wslDistributionSchema = z.strictObject({
  name: z.string().min(1),
  isSystemDefault: z.boolean(),
  isConfiguredDefault: z.boolean(),
})
export type WslDistribution = z.infer<typeof wslDistributionSchema>

export const wslEnvironmentSchema = z.strictObject({
  version: z.string().optional(),
  supportsCd: z.boolean(),
  distributions: z.array(wslDistributionSchema),
  systemDefault: z.string().optional(),
  configuredDefault: z.string().optional(),
  effectiveDefault: z.string().optional(),
})
export type WslEnvironment = z.infer<typeof wslEnvironmentSchema>
