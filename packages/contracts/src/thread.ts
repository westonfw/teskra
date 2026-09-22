import { z } from 'zod'

import { IPC_TEXT_MAX, ipcIdSchema } from './limits'

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
