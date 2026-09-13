import { z } from 'zod'

import { IPC_PATH_MAX } from './limits'
import { workspaceRuntimeRefSchema } from './workspace'

/**
 * Milestone 24 / ADR-0009 — a multi-subscription account is a full CLI Home
 * (docs/teskra-multi-account-subscription-implementation.md §5). One Agent can
 * have several account profiles, each pointing at an isolated CLI config root
 * (`CODEX_HOME` / `CLAUDE_CONFIG_DIR`); "account = environment".
 */

/**
 * §16 — auth/quota availability only. `disabled` is deliberately NOT a status:
 * the management state has a single source of truth in `enabled`.
 */
export const ACCOUNT_PROFILE_STATUSES = [
  'ready',
  'login-required',
  'limited',
  'expired',
  'unknown',
] as const
export const accountProfileStatusSchema = z.enum(ACCOUNT_PROFILE_STATUSES)
export type AccountProfileStatus = z.infer<typeof accountProfileStatusSchema>

export const ACCOUNT_AUTH_TYPES = ['subscription', 'api-key', 'external'] as const
export const accountAuthTypeSchema = z.enum(ACCOUNT_AUTH_TYPES)
export type AccountAuthType = z.infer<typeof accountAuthTypeSchema>

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/

/**
 * §5.3 — the persisted `configHome` is the normalized ABSOLUTE path inside the
 * profile's target runtime. `~` is never expanded inside env values (and would
 * reach the CLI as a literal directory named `~`), environment variable
 * references would resolve against the wrong account, and relative paths are
 * meaningless to a CLI launched with an arbitrary cwd — so all three forms are
 * rejected. `~` may only appear in user-facing UI copy; expansion happens once
 * at profile creation time.
 */
export const configHomeSchema = z
  .string()
  .min(1)
  .max(IPC_PATH_MAX)
  .refine((value) => !value.startsWith('~'), {
    message: 'configHome must be an expanded absolute path, not ~/...',
  })
  .refine((value) => !value.includes('$') && !value.includes('%'), {
    message: 'configHome must not contain environment variable references ($VAR / %VAR%)',
  })
  .refine(
    (value) =>
      value.startsWith('/') || value.startsWith('\\\\') || WINDOWS_DRIVE_ABSOLUTE.test(value),
    {
      message:
        'configHome must be an absolute path (POSIX /..., Windows drive X:\\, or UNC \\\\...)',
    },
  )

/**
 * §5.1. `runtime` reuses WorkspaceRuntimeRef so a distro mismatch
 * (an Ubuntu-22.04 profile landing on a Debian workspace) stays detectable —
 * never a "windows" | "wsl" two-value enum.
 */
export const agentAccountProfileSchema = z
  .strictObject({
    id: z.string().min(1),
    /** AgentDefinition.id — a free-form string, never a hardcoded enum. */
    agentId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    authType: accountAuthTypeSchema,
    runtime: workspaceRuntimeRefSchema,
    /**
     * CLI Home / Config Root. Never holds OAuth tokens directly. Optional:
     * `external` profiles may inherit the legacy CLI default environment.
     */
    configHome: configHomeSchema.optional(),
    /**
     * §46 — undefined = unlimited; managed profiles are created with 1. 0 or a
     * negative value would queue this profile's Runs forever, so it is rejected.
     */
    maxConcurrentRuns: z.number().int().min(1).optional(),
    status: accountProfileStatusSchema,
    limitedUntil: z.string().datetime().optional(),
    lastUsedAt: z.string().datetime().optional(),
    lastSuccessfulAt: z.string().datetime().optional(),
    lastFailureAt: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    /** The single source of truth for the management state (§16 / §47). */
    enabled: z.boolean(),
  })
  .superRefine((profile, context) => {
    // First phase only ships windows / wsl profiles (mirrors the
    // `runtime_kind IN ('windows','wsl')` CHECK in migration 012).
    if (profile.runtime.kind !== 'windows' && profile.runtime.kind !== 'wsl') {
      context.addIssue({
        code: 'custom',
        path: ['runtime', 'kind'],
        message: "account profiles only support 'windows' or 'wsl' runtimes",
      })
    }
    // §7 cross-object constraint: a wsl profile must pin its distro — falling
    // back to "whatever the default distro is" would silently change which
    // account the CLI authenticates as when the default changes.
    if (
      profile.runtime.kind === 'wsl' &&
      (profile.runtime.distro === undefined || profile.runtime.distro.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['runtime', 'distro'],
        message: "runtime.distro is required when runtime.kind is 'wsl'",
      })
    }
  })
export type AgentAccountProfile = z.infer<typeof agentAccountProfileSchema>

/**
 * §7 — the profile state captured when a Run starts, so history stays
 * auditable after the profile is later renamed or reconfigured. Persisted in
 * `agent_runs.profile_snapshot_json` (migration 013).
 */
export const agentRunProfileSnapshotSchema = z.strictObject({
  accountProfileId: z.string().min(1).optional(),
  accountProfileName: z.string().min(1).optional(),
  executionProfileId: z.string().min(1).optional(),
  executionProfileName: z.string().min(1).optional(),
  runtime: workspaceRuntimeRefSchema.optional(),
  configHome: configHomeSchema.optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
})
export type AgentRunProfileSnapshot = z.infer<typeof agentRunProfileSnapshotSchema>

/**
 * §40 — the identity every Run lifecycle operation (start / resume / recover /
 * continue / delegate) carries explicitly.
 */
export const agentRuntimeIdentitySchema = z.strictObject({
  agentId: z.string().min(1),
  accountProfileId: z.string().min(1).optional(),
  executionProfileId: z.string().min(1).optional(),
  /** Same shape as AgentAccountProfile.runtime (§5.1). */
  runtime: workspaceRuntimeRefSchema,
  configHome: configHomeSchema.optional(),
})
export type AgentRuntimeIdentity = z.infer<typeof agentRuntimeIdentitySchema>
