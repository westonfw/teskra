import { describe, expect, it } from 'vitest'

import {
  AGENT_OBSERVATION_PAYLOAD_MAX,
  AGENT_OBSERVATION_TEXT_MAX,
  agentObservationRecordSchema,
  agentObservationSchema,
  agentObservationSummarySchema,
  listAgentObservationsRequestSchema,
} from './agent-observation'

describe('agent-observation contracts (TASK-123 / ADR-0013)', () => {
  it('accepts every observation kind of the discriminated union', () => {
    const observations: unknown[] = [
      { kind: 'session', sessionId: 's-1' },
      { kind: 'assistant_text', text: 'hello' },
      { kind: 'tool_call', toolName: 'Bash', input: '{"command":"ls"}', command: 'ls' },
      { kind: 'tool_call', toolName: 'Read', input: '{"file_path":"/x"}' },
      { kind: 'tool_result', toolName: 'Bash', ok: true, output: 'done' },
      { kind: 'tool_result', ok: false, output: 'boom' },
      {
        kind: 'usage',
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        costUsdMicros: 123,
        model: 'claude-sonnet-4-5',
      },
      { kind: 'usage', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { kind: 'error', message: 'rate limited', code: '429' },
      { kind: 'result', ok: true, durationMs: 10, turns: 2 },
      { kind: 'result', ok: false },
    ]
    for (const observation of observations) {
      expect(agentObservationSchema.safeParse(observation).success).toBe(true)
    }
  })

  it('rejects unknown kinds and extra keys (strictObject)', () => {
    expect(agentObservationSchema.safeParse({ kind: 'mystery' }).success).toBe(false)
    expect(
      agentObservationSchema.safeParse({ kind: 'session', sessionId: 's', extra: 1 }).success,
    ).toBe(false)
  })

  it('enforces the truncation ceilings', () => {
    expect(
      agentObservationSchema.safeParse({
        kind: 'assistant_text',
        text: 'a'.repeat(AGENT_OBSERVATION_TEXT_MAX + 1),
      }).success,
    ).toBe(false)
    expect(
      agentObservationSchema.safeParse({
        kind: 'tool_result',
        ok: true,
        output: 'o'.repeat(AGENT_OBSERVATION_PAYLOAD_MAX + 1),
      }).success,
    ).toBe(false)
  })

  it('validates the summary payload and the list request', () => {
    expect(agentObservationSummarySchema.safeParse({ parsed: 3, ignored: 1 }).success).toBe(true)
    expect(agentObservationSummarySchema.safeParse({ parsed: -1, ignored: 0 }).success).toBe(false)
    expect(
      listAgentObservationsRequestSchema.safeParse({ runId: 'run-1', afterSeq: 5, limit: 50 })
        .success,
    ).toBe(true)
    expect(
      listAgentObservationsRequestSchema.safeParse({ runId: 'run-1', limit: 10_000 }).success,
    ).toBe(false)
  })

  it('round-trips a persisted record', () => {
    const record = {
      seq: 7,
      observation: { kind: 'result', ok: true },
      createdAt: '2026-09-21T00:00:00.000Z',
    }
    expect(agentObservationRecordSchema.safeParse(record).success).toBe(true)
  })
})
