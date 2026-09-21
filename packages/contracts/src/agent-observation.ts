import { z } from 'zod'

import { ipcIdSchema } from './limits'

/**
 * TASK-123 / ADR-0013 — the normalized observation parsed from an Agent's
 * exec-mode structured output stream (`claude-stream-json` /
 * `codex-exec-json` NDJSON on stdout).
 *
 * Observations are OBSERVATION-ONLY: they never drive Run status transitions,
 * never trigger termination, and are never a Handoff source. Every line is
 * best-effort — unknown types, non-JSON lines and oversized lines are dropped
 * and counted into the run's `agent.observation_summary`.
 */

export const AGENT_OBSERVATION_KINDS = [
  'session',
  'assistant_text',
  'tool_call',
  'tool_result',
  'usage',
  'error',
  'result',
] as const
export const agentObservationKindSchema = z.enum(AGENT_OBSERVATION_KINDS)
export type AgentObservationKind = z.infer<typeof agentObservationKindSchema>

/** §6.2: assistant text is capped at 8 KiB, tool payloads at 4 KiB (chars). */
export const AGENT_OBSERVATION_TEXT_MAX = 8 * 1024
export const AGENT_OBSERVATION_PAYLOAD_MAX = 4 * 1024

export const agentSessionObservationSchema = z.strictObject({
  kind: z.literal('session'),
  sessionId: z.string().min(1),
})
export const agentAssistantTextObservationSchema = z.strictObject({
  kind: z.literal('assistant_text'),
  text: z.string().max(AGENT_OBSERVATION_TEXT_MAX),
})
export const agentToolCallObservationSchema = z.strictObject({
  kind: z.literal('tool_call'),
  toolName: z.string().min(1),
  /** The tool input serialized to JSON, truncated to 4 KiB. */
  input: z.string().max(AGENT_OBSERVATION_PAYLOAD_MAX),
  /**
   * Command-class tools only (Claude `Bash`, Codex `command_execution`): the
   * extracted shell command, also persisted as an `agent.command` audit event.
   */
  command: z.string().min(1).max(AGENT_OBSERVATION_PAYLOAD_MAX).optional(),
})
export const agentToolResultObservationSchema = z.strictObject({
  kind: z.literal('tool_result'),
  toolName: z.string().min(1).optional(),
  ok: z.boolean(),
  /** The tool output serialized, truncated to 4 KiB. */
  output: z.string().max(AGENT_OBSERVATION_PAYLOAD_MAX),
})
export const agentUsageObservationSchema = z.strictObject({
  kind: z.literal('usage'),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  /**
   * ADR-0013 §6: only the provider-reported cost is recorded (micros of USD);
   * absent when the stream does not report one — never estimated locally.
   */
  costUsdMicros: z.number().int().nonnegative().optional(),
  model: z.string().min(1).optional(),
})
export const agentErrorObservationSchema = z.strictObject({
  kind: z.literal('error'),
  message: z.string().min(1).max(AGENT_OBSERVATION_PAYLOAD_MAX),
  code: z.string().min(1).optional(),
})
export const agentResultObservationSchema = z.strictObject({
  kind: z.literal('result'),
  ok: z.boolean(),
  durationMs: z.number().nonnegative().optional(),
  turns: z.number().int().nonnegative().optional(),
})

export const agentObservationSchema = z.discriminatedUnion('kind', [
  agentSessionObservationSchema,
  agentAssistantTextObservationSchema,
  agentToolCallObservationSchema,
  agentToolResultObservationSchema,
  agentUsageObservationSchema,
  agentErrorObservationSchema,
  agentResultObservationSchema,
])
export type AgentObservation = z.infer<typeof agentObservationSchema>
export type AgentSessionObservation = z.infer<typeof agentSessionObservationSchema>
export type AgentUsageObservation = z.infer<typeof agentUsageObservationSchema>
export type AgentErrorObservation = z.infer<typeof agentErrorObservationSchema>

/** ADR-0013 §5: per-run parse tallies persisted as `agent.observation_summary`. */
export const agentObservationSummarySchema = z.strictObject({
  parsed: z.number().int().nonnegative(),
  ignored: z.number().int().nonnegative(),
})
export type AgentObservationSummary = z.infer<typeof agentObservationSummarySchema>

/**
 * One persisted `agent.observation` event as returned by
 * `teskra:agent:list-observations` — `seq` aligns with the events.jsonl line
 * number / `agent_events.seq`, so `afterSeq` paging is stable.
 */
export const agentObservationRecordSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  observation: agentObservationSchema,
  createdAt: z.string().datetime(),
})
export type AgentObservationRecord = z.infer<typeof agentObservationRecordSchema>

export const LIST_AGENT_OBSERVATIONS_DEFAULT_LIMIT = 200
export const LIST_AGENT_OBSERVATIONS_MAX_LIMIT = 1_000

export const listAgentObservationsRequestSchema = z.strictObject({
  runId: ipcIdSchema,
  /** Only records with seq strictly greater than this are returned. */
  afterSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(LIST_AGENT_OBSERVATIONS_MAX_LIMIT).optional(),
})
export type ListAgentObservationsRequest = z.infer<typeof listAgentObservationsRequestSchema>
