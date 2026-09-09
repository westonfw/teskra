import { z } from 'zod'

/**
 * Config Layers (TASK-080, teskra-tasks.md; plan §151 / ADR-0005).
 *
 * Four layers, later ones override earlier ones:
 *
 *   default   built-in defaults (DEFAULT_CONFIG below)
 *   global    ~/.teskra/config.json        (Settings UI 回写)
 *   workspace <repo>/.teskra/config.json   (可提交，团队共享；禁止敏感值)
 *   override  Task / Run override          (由调用方直接提供)
 *
 * This module holds only the schemas, the layer names and the built-in
 * defaults — pure zod, no Node builtins (contracts ships in the sandboxed
 * preload bundle). File loading, deep-merge and secret scanning live in
 * apps/desktop/src/main/config/.
 *
 * The schema covers the keys current Tasks already need (TASK-004 logging,
 * TASK-084 concurrency, TASK-085 watchdog). New Tasks extend it by adding a
 * field to a group schema (or a new group) plus a default — nothing else
 * changes.
 */

export const CONFIG_LAYERS = ['default', 'global', 'workspace', 'override'] as const
export const configLayerNameSchema = z.enum(CONFIG_LAYERS)
export type ConfigLayerName = z.infer<typeof configLayerNameSchema>

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export const logLevelSchema = z.enum(LOG_LEVELS)
export type LogLevel = z.infer<typeof logLevelSchema>

export const loggingConfigSchema = z.strictObject({
  level: logLevelSchema,
})
export type LoggingConfig = z.infer<typeof loggingConfigSchema>

/** plan §147 / TASK-084. */
export const concurrencyConfigSchema = z.strictObject({
  maxGlobalRuns: z.number().int().min(1),
  maxRunsPerWorkspace: z.number().int().min(1),
  maxRunsPerAgent: z.number().int().min(1),
})
export type ConcurrencyConfig = z.infer<typeof concurrencyConfigSchema>

/** plan §148 / TASK-085: "possibly stalled" after this long without output. */
export const watchdogConfigSchema = z.strictObject({
  stalledThresholdMs: z.number().int().min(1000),
})
export type WatchdogConfig = z.infer<typeof watchdogConfigSchema>

/**
 * TASK-011: host environment preferences. `defaultDistro` is the WSL distro
 * Teskra uses when a workspace does not name one; null = fall back to the
 * Windows-side WSL default. Written by the Settings Environment section
 * (mounted by TASK-093); persisted in the global layer.
 */
export const environmentConfigSchema = z.strictObject({
  defaultDistro: z.string().min(1).nullable(),
})
export type EnvironmentConfig = z.infer<typeof environmentConfigSchema>

/** TASK-023: machine-specific Agent executable paths, keyed by Agent + runtime target. */
export const agentsConfigSchema = z.strictObject({
  executableOverrides: z.record(z.string().min(1), z.string().min(1).nullable()),
})
export type AgentsConfig = z.infer<typeof agentsConfigSchema>

export const teskraConfigSchema = z.strictObject({
  logging: loggingConfigSchema,
  concurrency: concurrencyConfigSchema,
  watchdog: watchdogConfigSchema,
  environment: environmentConfigSchema,
  agents: agentsConfigSchema,
})
export type TeskraConfig = z.infer<typeof teskraConfigSchema>

/**
 * A single config FILE / override layer: every group and field optional
 * (zod v4 `.partial()` is shallow, which is exactly the one-level-deep group
 * shape here). Unknown keys still fail — layers must not invent fields.
 */
export const teskraConfigLayerSchema = z.strictObject({
  logging: loggingConfigSchema.partial().optional(),
  concurrency: concurrencyConfigSchema.partial().optional(),
  watchdog: watchdogConfigSchema.partial().optional(),
  environment: environmentConfigSchema.partial().optional(),
  agents: agentsConfigSchema.partial().optional(),
})
export type TeskraConfigLayer = z.infer<typeof teskraConfigLayerSchema>

/** plan §147 defaults 4/3/2; TASK-085 stalled threshold 10 minutes. */
export const DEFAULT_CONFIG: TeskraConfig = {
  logging: { level: 'info' },
  concurrency: { maxGlobalRuns: 4, maxRunsPerWorkspace: 3, maxRunsPerAgent: 2 },
  watchdog: { stalledThresholdMs: 10 * 60 * 1000 },
  environment: { defaultDistro: null },
  agents: { executableOverrides: {} },
}

/**
 * Per-field provenance for the Settings UI ("此项来自 workspace 配置"):
 * dotted leaf path (e.g. "concurrency.maxGlobalRuns") → the layer whose
 * value won.
 */
export type ConfigSources = Record<string, ConfigLayerName>

export const configSourcesSchema = z.record(z.string(), configLayerNameSchema)

export const configWarningSchema = z.strictObject({
  layer: configLayerNameSchema,
  fieldPath: z.string().optional(),
  message: z.string(),
})
export type ConfigWarning = z.infer<typeof configWarningSchema>

export const resolvedConfigSchema = z.strictObject({
  config: teskraConfigSchema,
  sources: configSourcesSchema,
  warnings: z.array(configWarningSchema),
})
export type ResolvedConfig = z.infer<typeof resolvedConfigSchema>

export const writableConfigLayerSchema = z.enum(['global', 'workspace'])
export type WritableConfigLayer = z.infer<typeof writableConfigLayerSchema>

export const resolveConfigRequestSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
})
export type ResolveConfigRequest = z.infer<typeof resolveConfigRequestSchema>

export const updateConfigRequestSchema = z
  .strictObject({
    layer: writableConfigLayerSchema,
    workspaceId: z.string().min(1).optional(),
    patch: teskraConfigLayerSchema,
  })
  .superRefine((request, context) => {
    if (request.layer === 'workspace' && request.workspaceId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['workspaceId'],
        message: 'workspaceId is required when writing the workspace layer',
      })
    }
  })
export type UpdateConfigRequest = z.infer<typeof updateConfigRequestSchema>
