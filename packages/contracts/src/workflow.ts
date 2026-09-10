import { z } from 'zod'

import { agentRoleSchema } from './agent'
import { worktreeIsolationSchema } from './git'

/**
 * Workflow enums mirror §139.1 (002_runs.sql): `workflow_runs.status`
 * (line 5254), `workflow_steps.node_type` (line 5267), `workflow_steps.status`
 * (line 5268). Node types align with the plan §116.3 discriminated union.
 */
export const WORKFLOW_RUN_STATUSES = [
  'created',
  'running',
  'waiting',
  'needs_user_review',
  'completed',
  'failed',
  'cancelled',
] as const
export const workflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUSES)
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>

export const WORKFLOW_NODE_TYPES = [
  'agent',
  'shell',
  'checkpoint',
  'condition',
  'criteria-gate',
  'review-panel',
] as const
export const workflowNodeTypeSchema = z.enum(WORKFLOW_NODE_TYPES)
export type WorkflowNodeType = z.infer<typeof workflowNodeTypeSchema>

export const WORKFLOW_STEP_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'cancelled',
] as const
export const workflowStepStatusSchema = z.enum(WORKFLOW_STEP_STATUSES)
export type WorkflowStepStatus = z.infer<typeof workflowStepStatusSchema>

/**
 * TASK-055 (plan §153): which iterations an AgentWorkflowNode participates
 * in. Declared on every node type because the §153 default workflow assigns
 * `runOn` to shell / review / gate nodes too; the task acceptance pins the
 * AgentWorkflowNode default. Iterate is NOT a graph cycle — the acyclic DAG
 * is executed once per iteration by the outer IterationController (TASK-062).
 */
export const WORKFLOW_RUN_ONS = ['first', 'subsequent', 'always'] as const
export const workflowRunOnSchema = z.enum(WORKFLOW_RUN_ONS)
export type WorkflowRunOn = z.infer<typeof workflowRunOnSchema>

/**
 * plan §153「dependsOn 的两种写法」: a plain node id (unconditional edge) or
 * `{ node, on }` (conditional edge). Legal `on` values depend on the UPSTREAM
 * node type; that cross-check lives in @teskra/shared's
 * validateWorkflowDefinition because Zod schemas here stay shape-only.
 */
export const workflowDependencySchema = z.union([
  z.string().min(1),
  z.strictObject({
    node: z.string().min(1),
    on: z.string().min(1).optional(),
  }),
])
export type WorkflowDependency = z.infer<typeof workflowDependencySchema>

const workflowNodeBase = {
  id: z.string().min(1),
  dependsOn: z.array(workflowDependencySchema).optional(),
  runOn: workflowRunOnSchema.default('always'),
}

export const agentWorkflowNodeSchema = z.strictObject({
  ...workflowNodeBase,
  type: z.literal('agent'),
  /** AgentRegistry id (ADR: agentType is a free-form string, never an enum). */
  agent: z.string().min(1),
  role: agentRoleSchema.optional(),
  isolation: worktreeIsolationSchema.optional(),
})
export type AgentWorkflowNode = z.infer<typeof agentWorkflowNodeSchema>

export const shellWorkflowNodeSchema = z.strictObject({
  ...workflowNodeBase,
  type: z.literal('shell'),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
})
export type ShellWorkflowNode = z.infer<typeof shellWorkflowNodeSchema>

/** Human checkpoint: execution pauses until the user confirms (TASK-060). */
export const checkpointWorkflowNodeSchema = z.strictObject({
  ...workflowNodeBase,
  type: z.literal('checkpoint'),
  message: z.string().optional(),
})
export type CheckpointWorkflowNode = z.infer<typeof checkpointWorkflowNodeSchema>

export const conditionWorkflowNodeSchema = z.strictObject({
  ...workflowNodeBase,
  type: z.literal('condition'),
  expression: z.string().min(1),
})
export type ConditionWorkflowNode = z.infer<typeof conditionWorkflowNodeSchema>

export const criteriaGateWorkflowNodeSchema = z.strictObject({
  ...workflowNodeBase,
  type: z.literal('criteria-gate'),
})
export type CriteriaGateWorkflowNode = z.infer<typeof criteriaGateWorkflowNodeSchema>

export const reviewPanelWorkflowNodeSchema = z.strictObject({
  ...workflowNodeBase,
  type: z.literal('review-panel'),
  agents: z.array(z.string().min(1)).min(1),
})
export type ReviewPanelWorkflowNode = z.infer<typeof reviewPanelWorkflowNodeSchema>

/** plan §116.3 discriminated union — `node.type` is the discriminator. */
export const workflowNodeSchema = z.discriminatedUnion('type', [
  agentWorkflowNodeSchema,
  shellWorkflowNodeSchema,
  checkpointWorkflowNodeSchema,
  conditionWorkflowNodeSchema,
  criteriaGateWorkflowNodeSchema,
  reviewPanelWorkflowNodeSchema,
])
export type WorkflowNode = z.infer<typeof workflowNodeSchema>

/**
 * WorkflowDefinition (TASK-055). Shape-only Zod validation; graph rules
 * (acyclic dependsOn, dangling references, conditional-edge cross-check,
 * per-iteration runOn connectivity) are enforced by
 * `validateWorkflowDefinition` in @teskra/shared.
 */
export const workflowDefinitionSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(workflowNodeSchema).min(1),
})
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>

/** One file under <repo>/.teskra/workflows/ (ADR-0005) after a load attempt. */
export const workflowDefinitionFileInfoSchema = z.strictObject({
  path: z.string().min(1),
  status: z.enum(['loaded', 'invalid']),
  /** Present whenever the file declared an id, even if validation failed. */
  id: z.string().optional(),
  definition: workflowDefinitionSchema.optional(),
  /** Human-readable rejection reasons when status is 'invalid'. */
  issues: z.array(z.string()),
})
export type WorkflowDefinitionFileInfo = z.infer<typeof workflowDefinitionFileInfoSchema>

export const listWorkflowDefinitionsRequestSchema = z.strictObject({
  workspaceId: z.string().min(1),
})
export type ListWorkflowDefinitionsRequest = z.infer<typeof listWorkflowDefinitionsRequestSchema>

export const loadWorkflowDefinitionRequestSchema = z.strictObject({
  workspaceId: z.string().min(1),
  definitionId: z.string().min(1),
})
export type LoadWorkflowDefinitionRequest = z.infer<typeof loadWorkflowDefinitionRequestSchema>
