import { z } from 'zod'

import { ipcIdSchema } from './limits'

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
 * TASK-084 concurrency, TASK-085 watchdog, TASK-122 observability). New Tasks extend it by adding a
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

/**
 * plan §148 / TASK-085: `stalledThresholdMs` is the UI hint threshold
 * ("possibly stalled"). TASK-119 (Milestone 25 §5) adds the action thresholds
 * the RunWatchdogService enforces: `preparingTimeoutMs` for runs stuck in
 * `preparing`, `idleTimeoutMs` for silent active runs (0 = disabled; the
 * shared inspectRunWatchdog judgement needs a threshold of at least 1s), and
 * `idleAction` choosing between asking the user and stopping the run.
 */
export const watchdogConfigSchema = z.strictObject({
  stalledThresholdMs: z.number().int().min(1000),
  preparingTimeoutMs: z.number().int().min(1000),
  idleTimeoutMs: z
    .number()
    .int()
    .min(0)
    .refine((value) => value === 0 || value >= 1000, {
      message: 'idleTimeoutMs is either 0 (disabled) or at least 1000',
    }),
  idleAction: z.enum(['ask', 'stop']),
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
  /**
   * Milestone 24 §15: per-Agent default account profile (agentId →
   * agent_account_profiles.id); null / absent = no default → legacy CLI
   * environment (§37.1 / §50.1). Machine-local, lives in the global layer
   * (the agents group is global-only).
   */
  defaultAccountProfiles: z.record(z.string().min(1), z.string().min(1).nullable()),
  /**
   * Milestone 24 §15 (TASK-109): per-Agent default execution profile
   * (agentId → agent_execution_profiles.id); null / absent = no default.
   * Same storage pattern as defaultAccountProfiles — machine-local,
   * global-only.
   */
  defaultExecutionProfiles: z.record(z.string().min(1), z.string().min(1).nullable()),
})
export type AgentsConfig = z.infer<typeof agentsConfigSchema>

/**
 * TASK-061 / plan §142: severity policy for the Review Aggregator.
 * `critical` and `high` findings always block; `medium` blocks only at the
 * configured count (0 = mediums never block); `low` never blocks.
 */
export const reviewConfigSchema = z.strictObject({
  mediumBlockThreshold: z.number().int().min(0),
})
export type ReviewConfig = z.infer<typeof reviewConfigSchema>

/**
 * TASK-069 / plan §135: RetentionService GC thresholds, in days. A worktree,
 * run log, or discarded run older than its threshold becomes a GC candidate.
 *
 * TASK-133 (Milestone 25 §11): `worktreeArtifactPatterns` names build-output
 * directories inside a worktree (matched against top-level and one-level-deep
 * directory names only — no glob); `worktreeArtifactIdleDays` is the idle
 * threshold after which a `ready`/`dirty` worktree without a live run loses
 * those directories.
 */
export const retentionConfigSchema = z.strictObject({
  mergedWorktreeDays: z.number().int().min(0),
  completedRunLogsDays: z.number().int().min(0),
  discardedRunDays: z.number().int().min(0),
  worktreeArtifactPatterns: z.array(z.string().min(1)),
  worktreeArtifactIdleDays: z.number().int().min(0),
})
export type RetentionConfig = z.infer<typeof retentionConfigSchema>

/**
 * TASK-122 (Milestone 25 §6.1): `structuredStream` gates the structured-output
 * protocol families declared on AgentDefinition (`output`). When false, exec
 * launches get byte-identical command lines to the pre-TASK-122 behavior.
 */
export const observabilityConfigSchema = z.strictObject({
  structuredStream: z.boolean(),
})
export type ObservabilityConfig = z.infer<typeof observabilityConfigSchema>

/**
 * TASK-128 (Milestone 25 §9.1, ADR-0014 §4): PendingDecision expiry timeouts,
 * in milliseconds. `0` (the default) means the kind never expires on its own.
 */
export const decisionsConfigSchema = z.strictObject({
  shellConfirmationTimeoutMs: z.number().int().min(0),
  stalledRunTimeoutMs: z.number().int().min(0),
})
export type DecisionsConfig = z.infer<typeof decisionsConfigSchema>

export const teskraConfigSchema = z.strictObject({
  logging: loggingConfigSchema,
  concurrency: concurrencyConfigSchema,
  watchdog: watchdogConfigSchema,
  environment: environmentConfigSchema,
  agents: agentsConfigSchema,
  review: reviewConfigSchema,
  retention: retentionConfigSchema,
  observability: observabilityConfigSchema,
  decisions: decisionsConfigSchema,
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
  review: reviewConfigSchema.partial().optional(),
  retention: retentionConfigSchema.partial().optional(),
  observability: observabilityConfigSchema.partial().optional(),
  decisions: decisionsConfigSchema.partial().optional(),
})
export type TeskraConfigLayer = z.infer<typeof teskraConfigLayerSchema>

/** plan §147 defaults 4/3/2; TASK-085 stalled threshold 10 minutes; TASK-119 §5.2/§5.3. */
export const DEFAULT_CONFIG: TeskraConfig = {
  logging: { level: 'info' },
  concurrency: { maxGlobalRuns: 4, maxRunsPerWorkspace: 3, maxRunsPerAgent: 2 },
  watchdog: {
    stalledThresholdMs: 10 * 60 * 1000,
    preparingTimeoutMs: 5 * 60 * 1000,
    idleTimeoutMs: 2 * 60 * 60 * 1000,
    idleAction: 'ask',
  },
  environment: { defaultDistro: null },
  agents: { executableOverrides: {}, defaultAccountProfiles: {}, defaultExecutionProfiles: {} },
  review: { mediumBlockThreshold: 0 },
  // plan §135: merged worktrees are collected quickly; run logs and discarded
  // runs get a longer window for post-hoc audit (ADR-0002).
  // TASK-133: node_modules / .next / .turbo are the default build artifacts;
  // ready/dirty worktrees keep them for a week of idleness.
  retention: {
    mergedWorktreeDays: 1,
    completedRunLogsDays: 30,
    discardedRunDays: 30,
    worktreeArtifactPatterns: ['node_modules', '.next', '.turbo'],
    worktreeArtifactIdleDays: 7,
  },
  observability: { structuredStream: true },
  // ADR-0014 §4: decisions never expire unless the user opts into a timeout.
  decisions: { shellConfirmationTimeoutMs: 0, stalledRunTimeoutMs: 0 },
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
  /**
   * Stable machine-readable identifier. When present, the renderer translates
   * `settings.warning.<kind>` and falls back to `message` for unknown kinds.
   */
  kind: z.string().min(1).optional(),
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
  workspaceId: ipcIdSchema.optional(),
})
export type ResolveConfigRequest = z.infer<typeof resolveConfigRequestSchema>

export const updateConfigRequestSchema = z
  .strictObject({
    layer: writableConfigLayerSchema,
    workspaceId: ipcIdSchema.optional(),
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
