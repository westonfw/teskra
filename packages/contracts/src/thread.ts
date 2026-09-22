import { z } from 'zod'

import { agentProgressEventSchema } from './agent-progress'
import {
  decisionKindSchema,
  decisionOptionSchema,
  decisionResolutionSchema,
  decisionSeveritySchema,
  decisionStatusSchema,
} from './decision'
import { IPC_NAME_MAX, IPC_TEXT_MAX, ipcIdSchema } from './limits'

/**
 * TASK-135 (Milestone 26 §9/§11) — the thread-first message entry point:
 * one text box sends a message; Main resolves the explainable run defaults
 * (TASK-134), creates the Task from the first line when `taskId` is absent,
 * pre-builds the worktree and starts the Run.
 *
 * `kind` anticipates TASK-136 (message directives): `/workflow` maps to
 * 'workflow' and `@<agent>` to 'review'; TASK-135 implements only 'run' —
 * every message without directives starts an AgentRun and `id` is its runId.
 */
export const SEND_TASK_MESSAGE_KINDS = ['run', 'review', 'workflow'] as const
export const sendTaskMessageKindSchema = z.enum(SEND_TASK_MESSAGE_KINDS)
export type SendTaskMessageKind = z.infer<typeof sendTaskMessageKindSchema>

/**
 * Per-send overrides from the expandable defaults row (TASK-135): they apply
 * to this send only and are never written back to config. Only the Agent /
 * account / execution profile are overridable — `mode` ('exec'),
 * `executionMode` ('orchestrated') and `approvalMode` ('safe-auto') are fixed
 * by the thread-mode hard constraints, so the attended + manual combination
 * cannot be expressed through this entry point.
 */
export const sendTaskMessageOverridesSchema = z.strictObject({
  agentType: ipcIdSchema.optional(),
  /** Explicit account profile; absent = the resolved default (or legacy CLI home). */
  accountProfileId: ipcIdSchema.optional(),
  executionProfileId: ipcIdSchema.optional(),
})
export type SendTaskMessageOverrides = z.infer<typeof sendTaskMessageOverridesSchema>

export const sendTaskMessageRequestSchema = z.strictObject({
  /** Absent = Main creates the Task from the first line of `text`. */
  taskId: ipcIdSchema.optional(),
  workspaceId: ipcIdSchema,
  text: z.string().trim().min(1).max(IPC_TEXT_MAX),
  overrides: sendTaskMessageOverridesSchema.optional(),
})
export type SendTaskMessageRequest = z.infer<typeof sendTaskMessageRequestSchema>

export const sendTaskMessageResultSchema = z.strictObject({
  taskId: z.string(),
  kind: sendTaskMessageKindSchema,
  /** kind 'run' → AgentRun id; 'review' → ReviewRun id; 'workflow' → WorkflowRun id. */
  id: z.string(),
})
export type SendTaskMessageResult = z.infer<typeof sendTaskMessageResultSchema>

/**
 * TASK-138 (Milestone 26 §5/§8) — ThreadItem: the read-only projection of a
 * Task's thread, discriminated on `kind`. The projection is a pure read model
 * (thread-projection.ts): nothing here is persisted, and every item is
 * derived from agent_runs / handoffs / agent_events / pending_decisions /
 * workflow_runs at request time.
 */

/** §8: joined assistant_text observations are capped at 32 KiB per reply. */
export const AGENT_REPLY_TEXT_MAX = 32 * 1024
/** §8: the terminal.log fallback carries the last 2 000 characters. */
export const TERMINAL_REPLY_TAIL_MAX = 2_000

export const TASK_THREAD_DEFAULT_LIMIT = 50
export const TASK_THREAD_MAX_LIMIT = 200

export const AGENT_REPLY_SOURCES = ['observation', 'handoff', 'terminal'] as const
export const agentReplySourceSchema = z.enum(AGENT_REPLY_SOURCES)
export type AgentReplySource = z.infer<typeof agentReplySourceSchema>

const threadItemBase = {
  /** Projection-local id (`user:<runId>`, `progress:<eventId>`, ...); cursor-stable. */
  id: z.string().min(1),
  createdAt: z.string().datetime(),
} as const

/** §5: the user's message is the prompt of the Run it started. */
export const threadUserMessageItemSchema = z.strictObject({
  kind: z.literal('user_message'),
  ...threadItemBase,
  runId: z.string().min(1),
  text: z.string(),
})
export type ThreadUserMessageItem = z.infer<typeof threadUserMessageItemSchema>

export const threadAgentReplyItemSchema = z.strictObject({
  kind: z.literal('agent_reply'),
  ...threadItemBase,
  runId: z.string().min(1),
  agentType: z.string().min(1),
  text: z.string().max(AGENT_REPLY_TEXT_MAX),
  source: agentReplySourceSchema,
  /** True when the joined assistant_text stream exceeded AGENT_REPLY_TEXT_MAX. */
  truncated: z.boolean(),
})
export type ThreadAgentReplyItem = z.infer<typeof threadAgentReplyItemSchema>

/** ADR-0012 progress events, projected one item per `agent.progress` row. */
export const threadAgentProgressItemSchema = z.strictObject({
  kind: z.literal('agent_progress'),
  ...threadItemBase,
  runId: z.string().min(1),
  event: agentProgressEventSchema,
})
export type ThreadAgentProgressItem = z.infer<typeof threadAgentProgressItemSchema>

/** ADR-0014: open and resolved decisions both stay visible in the thread. */
export const threadDecisionItemSchema = z.strictObject({
  kind: z.literal('decision'),
  ...threadItemBase,
  decisionId: z.string().min(1),
  runId: z.string().min(1).optional(),
  workflowRunId: z.string().min(1).optional(),
  decisionKind: decisionKindSchema,
  severity: decisionSeveritySchema,
  status: decisionStatusSchema,
  title: z.string().min(1),
  options: z.array(decisionOptionSchema).min(1),
  resolution: decisionResolutionSchema.optional(),
})
export type ThreadDecisionItem = z.infer<typeof threadDecisionItemSchema>

export const THREAD_SYSTEM_KINDS = ['review', 'workflow', 'status', 'terminal'] as const
export const threadSystemKindSchema = z.enum(THREAD_SYSTEM_KINDS)
export type ThreadSystemKind = z.infer<typeof threadSystemKindSchema>

/** §5: Review / Workflow cards, notable Run status changes, and interactive runs (shown as a single "running in the terminal" entry). */
export const threadSystemItemSchema = z.strictObject({
  kind: z.literal('system'),
  ...threadItemBase,
  systemKind: threadSystemKindSchema,
  runId: z.string().min(1).optional(),
  workflowRunId: z.string().min(1).optional(),
  status: z.string().min(1),
  text: z.string().min(1),
})
export type ThreadSystemItem = z.infer<typeof threadSystemItemSchema>

export const threadItemSchema = z.discriminatedUnion('kind', [
  threadUserMessageItemSchema,
  threadAgentReplyItemSchema,
  threadAgentProgressItemSchema,
  threadDecisionItemSchema,
  threadSystemItemSchema,
])
export type ThreadItem = z.infer<typeof threadItemSchema>

/** teskra:task:thread — cursor-paged read of a Task's thread projection. */
export const taskThreadRequestSchema = z.strictObject({
  taskId: ipcIdSchema,
  /** Opaque cursor from a previous response's `nextCursor`. */
  afterCursor: z.string().min(1).max(IPC_NAME_MAX).optional(),
  limit: z.number().int().positive().max(TASK_THREAD_MAX_LIMIT).optional(),
})
export type TaskThreadRequest = z.infer<typeof taskThreadRequestSchema>

export const taskThreadResponseSchema = z.strictObject({
  items: z.array(threadItemSchema),
  nextCursor: z.string().min(1).optional(),
})
export type TaskThreadResponse = z.infer<typeof taskThreadResponseSchema>
