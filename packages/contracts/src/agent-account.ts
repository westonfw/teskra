import { z } from 'zod'

import {
  IPC_PATH_MAX,
  ipcContentSchema,
  ipcIdSchema,
  ipcNameSchema,
  terminalDimensionSchema,
} from './limits'
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

/**
 * §18.0 — conservative default window for a `limited` profile whose provider
 * gave no parseable reset time. The §18 projection writes
 * `limitedUntil = lastFailureAt + ACCOUNT_LIMITED_DEFAULT_DURATION_MS` instead
 * of leaving the column empty, and a legacy `limited` row without
 * `limitedUntil` reads as expired once its `lastFailureAt` is older than this
 * window — so such a profile can never be excluded from the §37 / §26
 * candidate lists forever. Shared by Main (status service) and Renderer
 * (continuation candidates) so both judge identically.
 */
export const ACCOUNT_LIMITED_DEFAULT_DURATION_MS = 60 * 60 * 1000

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

// --------------------------------------------------------------------
// TASK-102 (§24/§28): IPC request/response schemas for the account domain.
// --------------------------------------------------------------------

/** §48.1 — the only user-controlled segment of a managed configHome. Case-insensitive: the Manager lowercases before storing (NTFS folds case). */
export const accountProfileSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/i, {
  message: 'slug must match ^[a-z0-9][a-z0-9-]{0,31}$ (letters, digits, dashes)',
})

/** Mirrors the runtime constraints of agentAccountProfileSchema (windows/wsl only; wsl pins its distro). */
const accountProfileRuntimeRequestSchema = workspaceRuntimeRefSchema.superRefine(
  (runtime, context) => {
    if (runtime.kind !== 'windows' && runtime.kind !== 'wsl') {
      context.addIssue({
        code: 'custom',
        path: ['kind'],
        message: "account profiles only support 'windows' or 'wsl' runtimes",
      })
    }
    if (runtime.kind === 'wsl' && (runtime.distro === undefined || runtime.distro.length === 0)) {
      context.addIssue({
        code: 'custom',
        path: ['distro'],
        message: "runtime.distro is required when runtime.kind is 'wsl'",
      })
    }
  },
)

export const listAccountProfilesRequestSchema = z.strictObject({
  agentId: ipcIdSchema.optional(),
  status: accountProfileStatusSchema.optional(),
  enabled: z.boolean().optional(),
})
export type ListAccountProfilesRequest = z.infer<typeof listAccountProfilesRequestSchema>

/**
 * §4.2 / §10.4 — the agentIds with a registered AgentAccountProfileAdapter,
 * i.e. the agents a NEW account profile can be created for. Response is a
 * plain string array (AgentDefinition.id values); existing profiles of an
 * agent whose adapter was removed still list through account.list.
 */
export const listAdapterAgentsRequestSchema = z.strictObject({})
export type ListAdapterAgentsRequest = z.infer<typeof listAdapterAgentsRequestSchema>

export const accountProfileIdRequestSchema = z.strictObject({
  id: ipcIdSchema,
})
export type AccountProfileIdRequest = z.infer<typeof accountProfileIdRequestSchema>

export const createAccountProfileRequestSchema = z
  .strictObject({
    agentId: ipcIdSchema,
    name: ipcNameSchema,
    description: ipcNameSchema.optional(),
    authType: accountAuthTypeSchema,
    runtime: accountProfileRuntimeRequestSchema,
    /**
     * Managed profiles (subscription) only — the single user-controlled path
     * segment. Managed configHome is generated by Main (§48.1), never sent.
     */
    slug: accountProfileSlugSchema.optional(),
    /** External profiles (§49) only: an existing CLI home, expanded absolute. */
    configHome: configHomeSchema.optional(),
    maxConcurrentRuns: z.number().int().min(1).optional(),
  })
  .superRefine((request, context) => {
    if (request.authType === 'external' && request.configHome === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['configHome'],
        message: 'an external account profile requires an existing CLI home path',
      })
    }
    if (request.authType !== 'external' && request.configHome !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['configHome'],
        message: 'a managed account profile never accepts configHome — it is generated (§48.1)',
      })
    }
  })
export type CreateAccountProfileRequest = z.infer<typeof createAccountProfileRequestSchema>

/** §48.1: configHome is immutable for every profile — the patch cannot carry it. */
export const updateAccountProfileRequestSchema = z.strictObject({
  id: ipcIdSchema,
  patch: z.strictObject({
    name: ipcNameSchema.optional(),
    /** null clears the description; undefined leaves it untouched. */
    description: ipcNameSchema.nullable().optional(),
    /** null clears the override (back to the profile default); >= 1 otherwise (§46). */
    maxConcurrentRuns: z.number().int().min(1).nullable().optional(),
  }),
})
export type UpdateAccountProfileRequest = z.infer<typeof updateAccountProfileRequestSchema>

export const removeAccountProfileRequestSchema = z.strictObject({
  id: ipcIdSchema,
  /** §47.1: also delete the local CLI profile data. Managed profiles only. */
  deleteHome: z.boolean().optional(),
})
export type RemoveAccountProfileRequest = z.infer<typeof removeAccountProfileRequestSchema>

export const setDefaultAccountProfileRequestSchema = z.strictObject({
  agentId: ipcIdSchema,
  /** §15: per-agent default; null clears it. */
  profileId: ipcIdSchema.nullable(),
})
export type SetDefaultAccountProfileRequest = z.infer<typeof setDefaultAccountProfileRequestSchema>

export const getDefaultAccountProfileRequestSchema = z.strictObject({
  agentId: ipcIdSchema,
})
export type GetDefaultAccountProfileRequest = z.infer<typeof getDefaultAccountProfileRequestSchema>

/**
 * §24.2 — the handle returned IMMEDIATELY by login:start; the OAuth/device
 * flow itself runs in the spawned CLI and streams through account.login.* events.
 */
export const accountLoginSessionSchema = z.strictObject({
  sessionId: z.string().min(1),
  profileId: z.string().min(1),
  /** ISO-8601 UTC. */
  startedAt: z.string().datetime(),
})
export type AccountLoginSession = z.infer<typeof accountLoginSessionSchema>

/** §24.1: the Renderer submits ONLY the profileId — argv/env are built in Main. */
export const startAccountLoginRequestSchema = z.strictObject({
  profileId: ipcIdSchema,
})
export type StartAccountLoginRequest = z.infer<typeof startAccountLoginRequestSchema>

export const writeAccountLoginRequestSchema = z.strictObject({
  sessionId: ipcIdSchema,
  data: ipcContentSchema,
})
export type WriteAccountLoginRequest = z.infer<typeof writeAccountLoginRequestSchema>

export const resizeAccountLoginRequestSchema = z.strictObject({
  sessionId: ipcIdSchema,
  cols: terminalDimensionSchema,
  rows: terminalDimensionSchema,
})
export type ResizeAccountLoginRequest = z.infer<typeof resizeAccountLoginRequestSchema>

export const cancelAccountLoginRequestSchema = z.strictObject({
  sessionId: ipcIdSchema,
})
export type CancelAccountLoginRequest = z.infer<typeof cancelAccountLoginRequestSchema>
