import { z } from 'zod'

import { approvalModeSchema } from './agent'
import { ipcIdSchema, ipcNameSchema } from './limits'

/**
 * Milestone 24 / TASK-109 — an execution profile bundles the per-Run launch
 * knobs (account, model, reasoning effort, approval mode) under one name so a
 * Run can pin them with a single id
 * (docs/teskra-multi-account-subscription-implementation.md §6.1, table in
 * §8.2 / migration 014). The field set is deliberately narrowed to what the
 * first phase can actually resolve: there are NO permission / tool / skill /
 * env profile IDs — those entities do not exist in the repository (§6.1);
 * adding them back takes the full §6.2立项 (contracts + table + Repository +
 * Manager + IPC per class).
 *
 * The three definitions of this shape — this schema, the design doc §6.1
 * interface, and the §8.2 table — must stay identical.
 */
export const agentExecutionProfileSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  /** AgentDefinition.id — a free-form string, never a hardcoded enum. */
  agentId: z.string().min(1),
  /**
   * The account the profile launches under. Must point at an
   * AgentAccountProfile whose agentId equals THIS profile's agentId — the
   * Manager enforces it on create/update (design §14: an explicit Run
   * accountProfileId overrides this).
   */
  accountProfileId: z.string().min(1).optional(),
  /** 既有 AgentRun.model / StartAgentRunRequest.model (§6.1). */
  model: z.string().min(1).optional(),
  /** Free-form string each Adapter interprets on its own (§6.1). */
  reasoningEffort: z.string().min(1).optional(),
  /** 既有 approvalModeSchema，投射走既有 permission-projection (§6.1). */
  approvalMode: approvalModeSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type AgentExecutionProfile = z.infer<typeof agentExecutionProfileSchema>

// --------------------------------------------------------------------
// TASK-110 IPC request schemas — same CRUD + default shape as the account
// domain (agent-account.ts); channels are registered with the facade port.
// --------------------------------------------------------------------

export const listExecutionProfilesRequestSchema = z.strictObject({
  agentId: ipcIdSchema.optional(),
})
export type ListExecutionProfilesRequest = z.infer<typeof listExecutionProfilesRequestSchema>

export const executionProfileIdRequestSchema = z.strictObject({
  id: ipcIdSchema,
})
export type ExecutionProfileIdRequest = z.infer<typeof executionProfileIdRequestSchema>

export const createExecutionProfileRequestSchema = z.strictObject({
  agentId: ipcIdSchema,
  name: ipcNameSchema,
  accountProfileId: ipcIdSchema.optional(),
  model: ipcNameSchema.optional(),
  reasoningEffort: ipcNameSchema.optional(),
  approvalMode: approvalModeSchema.optional(),
})
export type CreateExecutionProfileRequest = z.infer<typeof createExecutionProfileRequestSchema>

/** `null` clears a field back to unset; `undefined` leaves it untouched. */
export const updateExecutionProfileRequestSchema = z.strictObject({
  id: ipcIdSchema,
  patch: z.strictObject({
    name: ipcNameSchema.optional(),
    accountProfileId: ipcIdSchema.nullable().optional(),
    model: ipcNameSchema.nullable().optional(),
    reasoningEffort: ipcNameSchema.nullable().optional(),
    approvalMode: approvalModeSchema.nullable().optional(),
  }),
})
export type UpdateExecutionProfileRequest = z.infer<typeof updateExecutionProfileRequestSchema>

/**
 * §15: per-agent default, stored in the global config layer
 * (`agents.defaultExecutionProfiles`) — same storage pattern as
 * `agents.defaultAccountProfiles`, never a Repository concern.
 */
export const setDefaultExecutionProfileRequestSchema = z.strictObject({
  agentId: ipcIdSchema,
  /** null clears the default. */
  profileId: ipcIdSchema.nullable(),
})
export type SetDefaultExecutionProfileRequest = z.infer<
  typeof setDefaultExecutionProfileRequestSchema
>

export const getDefaultExecutionProfileRequestSchema = z.strictObject({
  agentId: ipcIdSchema,
})
export type GetDefaultExecutionProfileRequest = z.infer<
  typeof getDefaultExecutionProfileRequestSchema
>
