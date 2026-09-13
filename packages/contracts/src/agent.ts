import { z } from 'zod'

import { agentRunProfileSnapshotSchema, configHomeSchema } from './agent-account'
import { agentFailureClassificationSchema } from './agent-failure'
import {
  IPC_TEXT_MAX,
  ipcContentSchema,
  ipcIdSchema,
  ipcPathSchema,
  ipcTextSchema,
  terminalDimensionSchema,
} from './limits'
import { taskSchema } from './task'
import { workspaceRuntimeRefSchema, workspaceSchema } from './workspace'

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

export const PERMISSION_ENFORCEMENT_MODES = ['native', 'config', 'none'] as const
export const permissionEnforcementSchema = z.enum(PERMISSION_ENFORCEMENT_MODES)
export type PermissionEnforcement = z.infer<typeof permissionEnforcementSchema>

/**
 * ADR-0002 / TASK-077 — the unified Teskra-side permission policy that is
 * projected onto each Agent CLI's own mechanism (settings file / launch args)
 * before the Run starts. This is pure data: the projection *functions* live on
 * the Main side (`main/agents/permission-projection.ts`), never in contracts.
 */
export const teskraPermissionProfileSchema = z.strictObject({
  id: z.string().min(1),
  approvalMode: approvalModeSchema,
  /** Tool/command rules the CLI should allow without prompting. */
  allow: z.array(z.string().min(1)).default([]),
  /** Tool/command rules the CLI should deny outright. */
  deny: z.array(z.string().min(1)).default([]),
})
export type TeskraPermissionProfile = z.infer<typeof teskraPermissionProfileSchema>

/**
 * A CLI-specific policy document generated from a TeskraPermissionProfile
 * (e.g. a Claude Code settings.json fragment). Written to the Run directory
 * before launch; `permissionConfigPath` on AgentStartRequest carries the path.
 */
export const agentPermissionConfigSchema = z.strictObject({
  /** Identifies the target document format, e.g. 'claude-code-settings'. */
  kind: z.string().min(1),
  document: z.record(z.string(), z.unknown()),
})
export type AgentPermissionConfig = z.infer<typeof agentPermissionConfigSchema>

export const AGENT_COST_CLASSES = ['low', 'medium', 'high'] as const
export const agentCostClassSchema = z.enum(AGENT_COST_CLASSES)

/**
 * ADR-0002 / P1-4 — one recognition rule for the post-hoc audit extractor.
 * Agents render their own TUIs instead of shell prompt lines, so each Agent
 * declares how an executed command looks in ITS output. `pattern` is matched
 * against a single full output line; capture group 1 is the command. When
 * `afterMarker` is set, `pattern` only applies to the line immediately
 * following a line that matches the marker regex (e.g. Codex `codex exec`
 * prints a bare `exec` marker line, then `<command> in <cwd>`).
 */
export const agentAuditCommandPatternSchema = z.strictObject({
  pattern: z.string().min(1),
  afterMarker: z.string().min(1).optional(),
})
export type AgentAuditCommandPattern = z.infer<typeof agentAuditCommandPatternSchema>

export const agentRoutingProfileSchema = z.strictObject({
  agentId: z.string().min(1),
  useWhen: z.string().min(1).optional(),
  strengths: z.array(z.string().min(1)).optional(),
  costClass: agentCostClassSchema.optional(),
  priority: z.number().int().optional(),
})
export type AgentRoutingProfile = z.infer<typeof agentRoutingProfileSchema>

/**
 * plan §116.2 — the single Agent Registry entry. `id` is a free-form string
 * (per TASK-003 / plan §21: agentType must NOT be a hardcoded enum, otherwise
 * TASK-022 Fake Agent cannot pass).
 */
export const agentDefinitionSchema = z
  .strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
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
    permissionEnforcement: permissionEnforcementSchema,
    /**
     * P1-4: TUI-specific command-recognition rules for the post-hoc audit.
     * Absent = only the generic shell-prompt heuristic applies. Recognition is
     * best-effort ("宁缺勿假"): full-screen TUI redraws may not be covered, so
     * an empty audit never proves no commands ran.
     */
    auditCommandPatterns: z.array(agentAuditCommandPatternSchema).optional(),
    routing: agentRoutingProfileSchema.optional(),
  })
  .superRefine((definition, context) => {
    if (definition.routing !== undefined && definition.routing.agentId !== definition.id) {
      context.addIssue({
        code: 'custom',
        path: ['routing', 'agentId'],
        message: 'routing.agentId must match the Agent definition id',
      })
    }
    definition.auditCommandPatterns?.forEach((rule, index) => {
      for (const [field, source] of [
        ['pattern', rule.pattern],
        ['afterMarker', rule.afterMarker],
      ] as const) {
        if (source === undefined) continue
        try {
          new RegExp(source)
        } catch {
          context.addIssue({
            code: 'custom',
            path: ['auditCommandPatterns', index, field],
            message: `auditCommandPatterns[${index}].${field} is not a valid regular expression`,
          })
        }
      }
    })
  })
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>

export const agentDetectionRequestSchema = z.strictObject({
  agentId: ipcIdSchema,
  runtime: workspaceRuntimeRefSchema,
  refresh: z.boolean().optional(),
})
export type AgentDetectionRequest = z.infer<typeof agentDetectionRequestSchema>

export const listAgentDetectionsRequestSchema = z.strictObject({
  runtime: workspaceRuntimeRefSchema,
  refresh: z.boolean().optional(),
})
export type ListAgentDetectionsRequest = z.infer<typeof listAgentDetectionsRequestSchema>

export const agentDetectionResultSchema = z.strictObject({
  agentId: z.string().min(1),
  runtime: workspaceRuntimeRefSchema,
  installed: z.boolean(),
  executable: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  overridden: z.boolean(),
  fromCache: z.boolean(),
  checkedAt: z.string().datetime(),
})
export type AgentDetectionResult = z.infer<typeof agentDetectionResultSchema>

export const agentQuotaSchema = z.strictObject({
  remaining: z.number().nonnegative().optional(),
  limit: z.number().positive().optional(),
  resetAt: z.string().datetime().optional(),
  source: z.string().min(1).optional(),
})
export type AgentQuota = z.infer<typeof agentQuotaSchema>

export const agentHealthSchema = z.strictObject({
  agentId: z.string().min(1),
  runtime: workspaceRuntimeRefSchema,
  installed: z.boolean(),
  authenticated: z.boolean().optional(),
  available: z.boolean(),
  rateLimited: z.boolean().optional(),
  quota: agentQuotaSchema.optional(),
  executable: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  checkedAt: z.string().datetime(),
})
export type AgentHealth = z.infer<typeof agentHealthSchema>

export const agentExecutableOverrideRequestSchema = z.strictObject({
  agentId: ipcIdSchema,
  runtime: workspaceRuntimeRefSchema,
})
export type AgentExecutableOverrideRequest = z.infer<typeof agentExecutableOverrideRequestSchema>

export const setAgentExecutableOverrideRequestSchema = agentExecutableOverrideRequestSchema.extend({
  path: ipcPathSchema.nullable(),
})
export type SetAgentExecutableOverrideRequest = z.infer<
  typeof setAgentExecutableOverrideRequestSchema
>

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
  /** TASK-077: resolved policy for this Run, projected by the Adapter into CLI args. */
  permissionProfile: teskraPermissionProfileSchema.optional(),
  /** TASK-077: CLI-side policy file written before launch (e.g. Claude settings.json). */
  permissionConfigPath: z.string().min(1).optional(),
  worktreePath: z.string().optional(),
  handoffPath: z.string().optional(),
  artifactDir: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
  /**
   * Milestone 24 §13.1: the resolved account-profile env (CODEX_HOME /
   * CLAUDE_CONFIG_DIR), populated by the AgentManager after profile
   * resolution. It merges AFTER `environment` (the launch slot) and before
   * the system-owned TESKRA_* keys, so a profile identity always wins over
   * workspace/request env.
   */
  profileEnvironment: z.record(z.string(), z.string()).optional(),
})
export type AgentStartRequest = z.infer<typeof agentStartRequestSchema>

/** plan §131 — opaque provider identity used to resume a persisted CLI session. */
export const providerSessionRefSchema = z.strictObject({
  provider: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type ProviderSessionRef = z.infer<typeof providerSessionRefSchema>

/**
 * Milestone 24 §10.5/§38 — the historical profile identity a resume is
 * validated against. Populated by the AgentManager from the run row
 * (`accountProfileId` + `profileSnapshot.configHome`) and the freshly read
 * profile record; the CLI adapter (e.g. Codex) refuses a resume whose account
 * changed and never falls back to "last session" for a profile run.
 */
export const agentResumeProfileContextSchema = z.strictObject({
  /** run.accountProfileId — its presence means this run uses a named account profile. */
  accountProfileId: z.string().min(1).optional(),
  /** run.profileSnapshot.configHome captured when the original run started. */
  snapshotConfigHome: configHomeSchema.optional(),
  /** configHome resolved for the current resume attempt. */
  currentConfigHome: configHomeSchema.optional(),
})
export type AgentResumeProfileContext = z.infer<typeof agentResumeProfileContextSchema>

export const agentResumeRequestSchema = agentStartRequestSchema.extend({
  providerSession: providerSessionRefSchema,
  resumeProfileContext: agentResumeProfileContextSchema.optional(),
})
export type AgentResumeRequest = z.infer<typeof agentResumeRequestSchema>

/** Public projection of plan §139.1 `agent_runs`; safe to return over Typed IPC. */
export const agentRunSchema = z.strictObject({
  id: z.string().min(1),
  taskId: z.string().optional(),
  workspaceId: z.string().min(1),
  workflowRunId: z.string().optional(),
  workflowStepId: z.string().optional(),
  agentType: z.string().min(1),
  /**
   * Milestone 24 (ADR-0009): the account / execution profiles this run was
   * launched with. Weak references by design (migration 013 sets no FK) — the
   * auditable truth is `profileSnapshot`.
   */
  accountProfileId: z.string().min(1).optional(),
  executionProfileId: z.string().min(1).optional(),
  /** Milestone 24 §7: profile state captured at start, for post-hoc audit. */
  profileSnapshot: agentRunProfileSnapshotSchema.optional(),
  /**
   * ADR-0010: why a failed run failed (rate limit, auth expiry, ...). Not a
   * Run status — the status stays 'failed' (migration 013).
   */
  failureClassification: agentFailureClassificationSchema.optional(),
  role: agentRoleSchema.optional(),
  model: z.string().optional(),
  /**
   * ADR-0007: the launch mode the run was started with ('interactive' | 'exec').
   * Persisted so resume relaunches with the original mode; absent on runs that
   * predate 009_agent_run_mode — resume treats those as 'interactive'.
   */
  mode: z.enum(['interactive', 'exec']).optional(),
  approvalMode: approvalModeSchema.optional(),
  status: agentRunStatusSchema,
  processId: z.string().optional(),
  pid: z.number().int().optional(),
  /**
   * Process-start token captured alongside `pid` (migration 011): compared
   * against a fresh probe before reconciliation terminates a surviving pid, so
   * a reused pid belonging to an unrelated process is never killed.
   */
  pidIdentity: z.string().optional(),
  worktreeId: z.string().optional(),
  executionMode: executionModeSchema,
  criteriaSetId: z.string().optional(),
  providerSession: z.record(z.string(), z.unknown()).optional(),
  runDir: z.string(),
  prompt: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  lastOutputAt: z.string().datetime().optional(),
  lastInputAt: z.string().datetime().optional(),
  exitCode: z.number().int().optional(),
  error: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type AgentRun = z.infer<typeof agentRunSchema>

export const startAgentRunRequestSchema = z.strictObject({
  workspaceId: ipcIdSchema,
  agentType: ipcIdSchema,
  /**
   * Pre-allocated Run id. Internal use only: services that must bind resources
   * to the Run before it launches (TASK-052 ReviewerService binds the
   * disposable-snapshot worktree to the Run id) pass one explicitly; everyone
   * else lets AgentManager generate it.
   */
  runId: ipcIdSchema.optional(),
  taskId: ipcIdSchema.optional(),
  /** Milestone 24 (ADR-0009): pin the run to a specific account / execution profile. */
  accountProfileId: ipcIdSchema.optional(),
  executionProfileId: ipcIdSchema.optional(),
  role: agentRoleSchema.optional(),
  model: ipcIdSchema.optional(),
  mode: z.enum(['interactive', 'exec']).optional(),
  approvalMode: approvalModeSchema.optional(),
  executionMode: executionModeSchema.optional(),
  worktreeId: ipcIdSchema.optional(),
  prompt: ipcTextSchema.optional(),
  environment: z.record(z.string(), z.string().max(IPC_TEXT_MAX)).optional(),
})
export type StartAgentRunRequest = z.infer<typeof startAgentRunRequestSchema>

/**
 * plan §126 ReviewIsolation — the three ways a Reviewer run is kept from
 * polluting the implement worktree (TASK-052). A subset of
 * WORKTREE_ISOLATIONS (§139.1 `worktrees.isolation`); plain 'worktree' is
 * never a valid review isolation.
 */
export const REVIEW_ISOLATIONS = [
  'shared-readonly',
  'worktree-readonly',
  'disposable-snapshot',
] as const
export const reviewIsolationSchema = z.enum(REVIEW_ISOLATIONS)
export type ReviewIsolation = z.infer<typeof reviewIsolationSchema>

/**
 * TASK-052: start a `reviewer`-role run with review isolation. The review
 * target is resolved from the most specific explicit reference first
 * (targetWorktreeId, then targetRunId, then the latest run of taskId that has
 * a worktree); with no resolvable target the review runs shared-readonly.
 */
export const startReviewRunRequestSchema = z.strictObject({
  workspaceId: ipcIdSchema,
  agentType: ipcIdSchema,
  taskId: ipcIdSchema.optional(),
  /**
   * Pre-allocated AgentRun id (TASK-060): the Review Panel allocates one id
   * per reviewer up-front so the prompt's handoff env paths (ADR-0004) match
   * the paths AgentManager injects before the Run exists.
   */
  runId: ipcIdSchema.optional(),
  /** Explicit implement run whose worktree the review targets. */
  targetRunId: ipcIdSchema.optional(),
  /** Explicit worktree the review targets. */
  targetWorktreeId: ipcIdSchema.optional(),
  model: ipcIdSchema.optional(),
  mode: z.enum(['interactive', 'exec']).optional(),
  executionMode: executionModeSchema.optional(),
  prompt: ipcTextSchema.optional(),
  environment: z.record(z.string(), z.string().max(IPC_TEXT_MAX)).optional(),
})
export type StartReviewRunRequest = z.infer<typeof startReviewRunRequestSchema>

export const reviewRunStartResultSchema = z.strictObject({
  run: agentRunSchema,
  /** The isolation tier the Reviewer was actually launched under. */
  isolation: reviewIsolationSchema,
})
export type ReviewRunStartResult = z.infer<typeof reviewRunStartResultSchema>

export const agentRunIdRequestSchema = z.strictObject({ runId: ipcIdSchema })
export type AgentRunIdRequest = z.infer<typeof agentRunIdRequestSchema>

export const agentRunOutputRequestSchema = agentRunIdRequestSchema.extend({
  /**
   * P1-6: when set, only the last `tailBytes` bytes of the run's terminal log
   * are returned. Omit for the full output (backward-compatible default).
   */
  tailBytes: z.number().int().positive().optional(),
})
export type AgentRunOutputRequest = z.infer<typeof agentRunOutputRequestSchema>

export const resumeAgentRunRequestSchema = agentRunIdRequestSchema.extend({
  prompt: z.string().trim().min(1).max(IPC_TEXT_MAX).optional(),
})
export type ResumeAgentRunRequest = z.infer<typeof resumeAgentRunRequestSchema>

export const sendAgentRunInputRequestSchema = agentRunIdRequestSchema.extend({
  data: ipcContentSchema,
})
export type SendAgentRunInputRequest = z.infer<typeof sendAgentRunInputRequestSchema>

export const resizeAgentRunRequestSchema = agentRunIdRequestSchema.extend({
  cols: terminalDimensionSchema,
  rows: terminalDimensionSchema,
})
export type ResizeAgentRunRequest = z.infer<typeof resizeAgentRunRequestSchema>

export const listAgentRunsRequestSchema = z.strictObject({
  workspaceId: ipcIdSchema.optional(),
  taskId: ipcIdSchema.optional(),
  activeOnly: z.boolean().optional(),
})
export type ListAgentRunsRequest = z.infer<typeof listAgentRunsRequestSchema>
