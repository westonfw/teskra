import { z } from 'zod'

import { ipcIdSchema, ipcNameSchema } from './limits'

/**
 * TASK-111 (Milestone 24 §53.1, ADR-0011) — workflow profile aliases.
 *
 * A Workflow definition is committed to the repo and shared between machines,
 * while a Profile id (`acct_codex_work`, `exec_…`) is machine-local. The
 * `profile_aliases` table (migration 012) is the ONLY mapping between the two:
 * the repo names a stable alias (`accountProfile: work`, `profile: high-work`)
 * and every machine binds that alias to its own local Profile in Settings.
 *
 * The primary key is `(agentId, kind, alias)`: the same alias can exist as an
 * account alias AND as an execution alias, and per Agent — the two Profile
 * tables' id namespaces cannot be assumed disjoint, so `kind` can never be
 * inferred from the profileId. There is deliberately no FK to the Profile
 * tables: deleting a Profile turns the alias "unbound" (resolution fails with
 * a bind prompt) instead of cascading the binding away.
 */

export const PROFILE_ALIAS_KINDS = ['account', 'execution'] as const
export const profileAliasKindSchema = z.enum(PROFILE_ALIAS_KINDS)
export type ProfileAliasKind = z.infer<typeof profileAliasKindSchema>

export const profileAliasSchema = z.strictObject({
  /** AgentDefinition.id — a free-form string, never a hardcoded enum. */
  agentId: z.string().min(1),
  kind: profileAliasKindSchema,
  /** The stable name written into repo workflows, e.g. "work". */
  alias: z.string().min(1),
  /** Machine-local Profile id this alias currently points at. */
  profileId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type ProfileAlias = z.infer<typeof profileAliasSchema>

// --------------------------------------------------------------------
// TASK-111 (§28): IPC request schemas for the alias channels.
// --------------------------------------------------------------------

export const listProfileAliasesRequestSchema = z.strictObject({
  agentId: ipcIdSchema.optional(),
  kind: profileAliasKindSchema.optional(),
})
export type ListProfileAliasesRequest = z.infer<typeof listProfileAliasesRequestSchema>

/**
 * Binding validates Main-side that `profileId` exists in the table `kind`
 * names (account → agent_account_profiles, execution →
 * agent_execution_profiles) and that `profile.agentId === agentId` — otherwise
 * a "codex alias pointing at a claude profile" only surfaces when a workflow
 * actually runs (§28).
 */
export const bindProfileAliasRequestSchema = z.strictObject({
  agentId: ipcIdSchema,
  kind: profileAliasKindSchema,
  alias: ipcNameSchema,
  profileId: ipcIdSchema,
})
export type BindProfileAliasRequest = z.infer<typeof bindProfileAliasRequestSchema>

export const unbindProfileAliasRequestSchema = z.strictObject({
  agentId: ipcIdSchema,
  kind: profileAliasKindSchema,
  alias: ipcNameSchema,
})
export type UnbindProfileAliasRequest = z.infer<typeof unbindProfileAliasRequestSchema>
