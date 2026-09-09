import { z } from 'zod'

import { taskSchema } from './task'
import { workspaceSchema } from './workspace'

/**
 * plan §17 AgentRunStatus — includes `interrupted`, the reconciliation-only
 * terminal state (resumable, unlike `failed`). §139.1 `agent_runs.status`
 * references §17 (line 5291); the active-run index (line 5316) confirms
 * 'running' | 'preparing' | 'queued'.
 */
export const AGENT_RUN_STATUSES = [
  'created',
  'queued',
  'preparing',
  'running',
  'waiting_for_user',
  'waiting_for_permission',
  'waiting_for_agent',
  'reviewing',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const
export const agentRunStatusSchema = z.enum(AGENT_RUN_STATUSES)
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>

/** §139.1 `agent_runs.role` (line 5287). */
export const AGENT_ROLES = ['planner', 'implementer', 'reviewer', 'tester', 'fixer'] as const
export const agentRoleSchema = z.enum(AGENT_ROLES)
export type AgentRole = z.infer<typeof agentRoleSchema>

/** §139.1 `agent_runs.approval_mode` (line 5289). */
export const APPROVAL_MODES = ['read-only', 'manual', 'safe-auto', 'full-auto'] as const
export const approvalModeSchema = z.enum(APPROVAL_MODES)
export type ApprovalMode = z.infer<typeof approvalModeSchema>

/** §139.1 `agent_runs.execution_mode` (line 5298, ADR-0002). */
export const EXECUTION_MODES = ['attended', 'orchestrated'] as const
export const executionModeSchema = z.enum(EXECUTION_MODES)
export type ExecutionMode = z.infer<typeof executionModeSchema>

export const agentExecutableDefinitionSchema = z.strictObject({
  command: z.string(),
  defaultArgs: z.array(z.string()).optional(),
})
export type AgentExecutableDefinition = z.infer<typeof agentExecutableDefinitionSchema>

/**
 * plan §116.2 — the single Agent Registry entry. `id` is a free-form string
 * (per TASK-003 / plan §21: agentType must NOT be a hardcoded enum, otherwise
 * TASK-022 Fake Agent cannot pass).
 */
export const agentDefinitionSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  executable: agentExecutableDefinitionSchema,
  capabilities: z.strictObject({
    interactive: z.boolean(),
    headless: z.boolean(),
    resume: z.boolean(),
    readOnlyMode: z.boolean(),
    modelSelection: z.boolean(),
  }),
  prompt: z.strictObject({
    interactiveArgs: z.array(z.string()).optional(),
    headlessArgs: z.array(z.string()).optional(),
  }),
  detection: z.strictObject({
    versionArgs: z.array(z.string()),
  }),
  defaults: z.strictObject({
    role: agentRoleSchema.optional(),
    permissionProfile: z.string().optional(),
  }),
})
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>

/**
 * plan §13 + ADR-0004 — `handoffPath` / `artifactDir` implement the file
 * contract (TESKRA_HANDOFF_PATH / TESKRA_ARTIFACT_DIR); stdout is never parsed.
 */
export const agentStartRequestSchema = z.strictObject({
  runId: z.string(),
  workspace: workspaceSchema,
  task: taskSchema.optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  mode: z.enum(['interactive', 'exec']).optional(),
  approvalMode: approvalModeSchema.optional(),
  worktreePath: z.string().optional(),
  handoffPath: z.string().optional(),
  artifactDir: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
})
export type AgentStartRequest = z.infer<typeof agentStartRequestSchema>
