import { z } from 'zod'

import { ipcIdSchema } from './limits'

/**
 * TASK-126 / ADR-0012 — the append-only Agent progress file contract.
 *
 * The Agent appends one JSON object per line to `TESKRA_PROGRESS_PATH`
 * (`<dataRoot>/runs/<runId>/progress.jsonl`); Teskra only reads and observes
 * (progress-follower.ts): lines are persisted as `agent.progress` events and
 * broadcast, `blocker` / `question` are surfaced through a callback (opening
 * a Decision is TASK-130's job). Run state is never changed by progress.
 */

export const AGENT_PROGRESS_KINDS = ['progress', 'blocker', 'question', 'note'] as const
export const agentProgressKindSchema = z.enum(AGENT_PROGRESS_KINDS)
export type AgentProgressKind = z.infer<typeof agentProgressKindSchema>

export const AGENT_PROGRESS_MESSAGE_MAX = 2_000
/** Serialized `data` payload ceiling (UTF-8 bytes), ADR-0012 §1. */
export const AGENT_PROGRESS_DATA_MAX_BYTES = 4 * 1024

export const agentProgressEventSchema = z
  .strictObject({
    kind: agentProgressKindSchema,
    message: z.string().min(1).max(AGENT_PROGRESS_MESSAGE_MAX),
    percent: z.number().int().min(0).max(100).optional(),
    /** Agent-declared timestamp; the follower fills read time when absent. */
    at: z.string().datetime().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((event, context) => {
    if (event.data === undefined) return
    // TextEncoder (web global) instead of Buffer: contracts must also run
    // inside the sandboxed preload, which has no Node globals.
    if (
      new TextEncoder().encode(JSON.stringify(event.data)).length > AGENT_PROGRESS_DATA_MAX_BYTES
    ) {
      context.addIssue({
        code: 'custom',
        path: ['data'],
        message: `data must serialize to at most ${String(AGENT_PROGRESS_DATA_MAX_BYTES)} bytes`,
      })
    }
  })
export type AgentProgressEvent = z.infer<typeof agentProgressEventSchema>

/**
 * One persisted `agent.progress` event as returned by
 * `teskra:agent:list-progress` — `seq` aligns with the events.jsonl line
 * number / `agent_events.seq`, so `afterSeq` paging is stable.
 */
export const agentProgressRecordSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  event: agentProgressEventSchema,
  createdAt: z.string().datetime(),
})
export type AgentProgressRecord = z.infer<typeof agentProgressRecordSchema>

export const LIST_AGENT_PROGRESS_DEFAULT_LIMIT = 200
export const LIST_AGENT_PROGRESS_MAX_LIMIT = 1_000

export const listAgentProgressRequestSchema = z.strictObject({
  runId: ipcIdSchema,
  /** Only records with seq strictly greater than this are returned. */
  afterSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(LIST_AGENT_PROGRESS_MAX_LIMIT).optional(),
})
export type ListAgentProgressRequest = z.infer<typeof listAgentProgressRequestSchema>
