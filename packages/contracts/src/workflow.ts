import { z } from 'zod'

import { agentRoleSchema, agentRunSchema } from './agent'
import { acceptanceCriterionSchema } from './criteria'
import { diffPatchResultSchema, worktreeIsolationSchema, worktreeSchema } from './git'
import { handoffRecordSchema } from './handoff'
import { IPC_NAME_MAX, ipcIdSchema, ipcTextSchema } from './limits'
import { criteriaReviewOutcomeSchema, criterionScoreRecordSchema } from './review'

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
  workspaceId: ipcIdSchema,
})
export type ListWorkflowDefinitionsRequest = z.infer<typeof listWorkflowDefinitionsRequestSchema>

export const loadWorkflowDefinitionRequestSchema = z.strictObject({
  workspaceId: ipcIdSchema,
  definitionId: ipcIdSchema,
})
export type LoadWorkflowDefinitionRequest = z.infer<typeof loadWorkflowDefinitionRequestSchema>

/**
 * Public projection of §139.1 `workflow_runs` (TASK-056), safe to return over
 * Typed IPC. `taskId` is optional — a WorkflowRun can exist independently of
 * any Task (ADR-0006). `definition` is the launch-time definition snapshot,
 * always a validated WorkflowDefinition so a restarted app can interpret it.
 */
export const workflowRunSchema = z.strictObject({
  id: z.string().min(1),
  taskId: z.string().min(1).optional(),
  workflowDefinitionId: z.string().min(1),
  definition: workflowDefinitionSchema,
  status: workflowRunStatusSchema,
  currentIteration: z.number().int().nonnegative(),
  totalIterations: z.number().int().nonnegative(),
  /**
   * TASK-062 (plan §124): rounds executed under the criteria set the run is
   * currently anchored to (`criteriaSetId`). Resets when the anchor changes;
   * `currentIteration` keeps counting across criteria versions.
   */
  criteriaIteration: z.number().int().nonnegative(),
  criteriaSetId: z.string().optional(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
})
export type WorkflowRun = z.infer<typeof workflowRunSchema>

/**
 * Public projection of §139.1 `workflow_steps` (TASK-056). The same node id
 * appears once per iteration (plan §153: 同一 node_id 多行是预期的).
 */
export const workflowStepSchema = z.strictObject({
  id: z.string().min(1),
  workflowRunId: z.string().min(1),
  nodeId: z.string().min(1),
  nodeType: workflowNodeTypeSchema,
  status: workflowStepStatusSchema,
  iteration: z.number().int().nonnegative(),
  attempt: z.number().int().positive(),
  dependsOn: z.array(z.string()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
})
export type WorkflowStep = z.infer<typeof workflowStepSchema>

/** Full recoverable state of one WorkflowRun: run row + all step rows. */
export const workflowRunDetailSchema = z.strictObject({
  run: workflowRunSchema,
  steps: z.array(workflowStepSchema),
})
export type WorkflowRunDetail = z.infer<typeof workflowRunDetailSchema>

export const workflowRunIdRequestSchema = z.strictObject({
  runId: ipcIdSchema,
})
export type WorkflowRunIdRequest = z.infer<typeof workflowRunIdRequestSchema>

export const listWorkflowRunsRequestSchema = z.strictObject({
  taskId: ipcIdSchema.optional(),
  status: workflowRunStatusSchema.optional(),
})
export type ListWorkflowRunsRequest = z.infer<typeof listWorkflowRunsRequestSchema>

/**
 * TASK-059 Dispatch Primitive (Task → One Agent → Handoff). `agent` is an
 * AgentRegistry id (free-form string, never an enum). Dispatch is always
 * orchestrated, so it always creates a worktree (ADR-0002 red line:
 * orchestrated without a worktree must be refused); `isolation` only selects
 * the worktree's isolation tier and defaults to 'worktree'.
 */
export const workflowDispatchRequestSchema = z.strictObject({
  workspaceId: ipcIdSchema,
  taskId: ipcIdSchema,
  agent: ipcIdSchema,
  isolation: worktreeIsolationSchema.optional(),
  model: ipcIdSchema.optional(),
  /** Explicit prompt; when omitted the 'implement' template (TASK-079) is rendered. */
  prompt: ipcTextSchema.optional(),
})
export type WorkflowDispatchRequest = z.infer<typeof workflowDispatchRequestSchema>

/**
 * Result of a settled dispatch: the WorkflowRun (final status), the AgentRun,
 * the worktree it ran in, and the collected handoff (ADR-0004; `null` only
 * when collection itself failed — a run that wrote nothing still yields a
 * 'missing' fallback row).
 */
export const workflowDispatchResultSchema = z.strictObject({
  run: workflowRunSchema,
  agentRun: agentRunSchema,
  worktree: worktreeSchema,
  handoffPath: z.string().min(1),
  handoff: handoffRecordSchema.nullable(),
})
export type WorkflowDispatchResult = z.infer<typeof workflowDispatchResultSchema>

/** TASK-059: starts one DAG pass of an existing WorkflowRun via WorkflowEngine. */
export const workflowRunStartRequestSchema = z.strictObject({
  runId: ipcIdSchema,
  workspaceId: ipcIdSchema,
  /** Present → agent steps run orchestrated; absent → attended (ADR-0002). */
  worktreeId: ipcIdSchema.optional(),
})
export type WorkflowRunStartRequest = z.infer<typeof workflowRunStartRequestSchema>

/** TASK-059: resolves a suspended step (checkpoint / criteria-gate / review-panel). */
export const workflowStepResolveRequestSchema = z.strictObject({
  stepId: ipcIdSchema,
  outcome: z.string().min(1).max(IPC_NAME_MAX).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
})
export type WorkflowStepResolveRequest = z.infer<typeof workflowStepResolveRequestSchema>

/**
 * TASK-062 Iterate Safety Cap (plan §124): two independent round limits.
 * `maxRoundsPerCriteriaVersion` anchors to the currently confirmed criteria
 * set version and resets when the user confirms a new version;
 * `maxTotalRounds` accumulates across criteria versions and never resets.
 */
export const iterationPolicySchema = z.strictObject({
  maxRoundsPerCriteriaVersion: z.number().int().positive(),
  maxTotalRounds: z.number().int().positive(),
})
export type IterationPolicy = z.infer<typeof iterationPolicySchema>

/** plan §124 defaults. */
export const DEFAULT_ITERATION_POLICY: IterationPolicy = {
  maxRoundsPerCriteriaVersion: 3,
  maxTotalRounds: 8,
}

/** How an iterate loop ended (TASK-062). */
export const WORKFLOW_ITERATE_STOP_REASONS = [
  'passed',
  'max_rounds_per_criteria_version',
  'max_total_rounds',
  'cancelled',
] as const
export const workflowIterateStopReasonSchema = z.enum(WORKFLOW_ITERATE_STOP_REASONS)
export type WorkflowIterateStopReason = z.infer<typeof workflowIterateStopReasonSchema>

/**
 * TASK-062 Iterate Primitive (Implement → Review → Fix → Review). Without
 * `runId` a new WorkflowRun is created from the built-in iterate definition
 * (then `agent` and `reviewers` are required); with `runId` an existing
 * capped run (`needs_user_review`) resumes — the per-version counter resets
 * only when the task's confirmed criteria set changed, the total never does.
 */
export const workflowIterateRequestSchema = z
  .strictObject({
    workspaceId: ipcIdSchema,
    taskId: ipcIdSchema,
    runId: ipcIdSchema.optional(),
    /** AgentRegistry id of the implementer/fixer agent (free-form string). */
    agent: ipcIdSchema.optional(),
    /** AgentRegistry ids of the review-panel reviewers. */
    reviewers: z.array(ipcIdSchema).min(1).optional(),
    policy: iterationPolicySchema.partial().optional(),
    /** Present → agent steps run orchestrated in this worktree (ADR-0002). */
    worktreeId: ipcIdSchema.optional(),
    model: ipcIdSchema.optional(),
    /** Round-1 prompt override; the 'implement' template is rendered otherwise. */
    prompt: ipcTextSchema.optional(),
    /** Round ≥2 prompt override; the 'fix' template is rendered otherwise. */
    fixPrompt: ipcTextSchema.optional(),
  })
  .refine(
    (request) =>
      request.runId !== undefined ||
      (request.agent !== undefined && request.reviewers !== undefined),
    {
      message: 'agent and reviewers are required when starting a new iterate run.',
    },
  )
export type WorkflowIterateRequest = z.infer<typeof workflowIterateRequestSchema>

export const workflowIterateResultSchema = z.strictObject({
  run: workflowRunSchema,
  /** Rounds executed in total (across criteria versions), 1-based. */
  rounds: z.number().int().nonnegative(),
  stopReason: workflowIterateStopReasonSchema,
})
export type WorkflowIterateResult = z.infer<typeof workflowIterateResultSchema>

/**
 * TASK-063 Default Full Workflow (teskra-tasks.md): the one-click launch from
 * the Task page — Acceptance Criteria → Create Worktree → Implement →
 * Build/Test → Review → Criteria Gate, with the FAIL loop driven by the
 * TASK-062 IterationController safety caps.
 *
 * `implementer` / `reviewers` / `testCommand` are explicit overrides; when
 * omitted they resolve from a repo-local `<repo>/.teskra/workflows/full.*`
 * definition (ADR-0005) and finally from the AgentRegistry's declared default
 * roles (never hardcoded agent ids).
 */
export const startFullWorkflowRequestSchema = z.strictObject({
  workspaceId: ipcIdSchema,
  taskId: ipcIdSchema,
  /** AgentRegistry id of the implementer/fixer agent (free-form string). */
  implementer: ipcIdSchema.optional(),
  /** AgentRegistry ids of the review-panel reviewers. */
  reviewers: z.array(ipcIdSchema).min(1).optional(),
  /** Shell step command for the Build/Test step (default 'npm test'). */
  testCommand: z.string().min(1).max(IPC_NAME_MAX).optional(),
  /** Worktree isolation tier (defaults to 'worktree'; always orchestrated, ADR-0002). */
  isolation: worktreeIsolationSchema.optional(),
  model: ipcIdSchema.optional(),
  /** Iteration safety-cap overrides (plan §124). */
  policy: iterationPolicySchema.partial().optional(),
})
export type StartFullWorkflowRequest = z.infer<typeof startFullWorkflowRequestSchema>

/**
 * A settled full-workflow launch: the WorkflowRun (final status — 'completed'
 * on pass, 'needs_user_review' on a triggered cap), the worktree it ran in,
 * and the IterationController outcome.
 */
export const fullWorkflowStartResultSchema = workflowIterateResultSchema.extend({
  worktree: worktreeSchema,
})
export type FullWorkflowStartResult = z.infer<typeof fullWorkflowStartResultSchema>

/**
 * TASK-063 completion view for one full-workflow run: the run + every step,
 * the worktree it ran in (null when none is linked), the worktree-branch diff
 * against its base branch (null when unavailable), and the anchored criteria
 * set's scores with the derived TASK-054 outcome. Computed on demand.
 */
export const fullWorkflowRunSummarySchema = z.strictObject({
  run: workflowRunSchema,
  steps: z.array(workflowStepSchema),
  worktree: worktreeSchema.nullable(),
  diff: diffPatchResultSchema.nullable(),
  /** Criteria rows of the run's anchored criteria set (empty when unanchored). */
  criteria: z.array(acceptanceCriterionSchema),
  /** Latest criterion scores recorded for the run's Task. */
  criterionScores: z.array(criterionScoreRecordSchema),
  /** computeCriteriaReviewOutcome over the anchored set; null without criteria. */
  criteriaOutcome: criteriaReviewOutcomeSchema.nullable(),
})
export type FullWorkflowRunSummary = z.infer<typeof fullWorkflowRunSummarySchema>
