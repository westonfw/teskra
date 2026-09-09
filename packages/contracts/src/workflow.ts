import { z } from 'zod'

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
