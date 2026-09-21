import { describe, expect, it } from 'vitest'

import {
  AGENT_PROGRESS_DATA_MAX_BYTES,
  AGENT_PROGRESS_KINDS,
  agentProgressEventSchema,
  listAgentProgressRequestSchema,
} from './agent-progress'

describe('agentProgressEventSchema (TASK-126 / ADR-0012)', () => {
  it('accepts every declared kind with a minimal message', () => {
    for (const kind of AGENT_PROGRESS_KINDS) {
      expect(agentProgressEventSchema.safeParse({ kind, message: 'm' }).success).toBe(true)
    }
  })

  it('rejects unknown kinds, empty messages and extra keys (strictObject)', () => {
    expect(agentProgressEventSchema.safeParse({ kind: 'status', message: 'm' }).success).toBe(false)
    expect(agentProgressEventSchema.safeParse({ kind: 'progress', message: '' }).success).toBe(
      false,
    )
    expect(
      agentProgressEventSchema.safeParse({ kind: 'progress', message: 'm', extra: 1 }).success,
    ).toBe(false)
  })

  it('bounds message length and percent range', () => {
    expect(
      agentProgressEventSchema.safeParse({ kind: 'note', message: 'x'.repeat(2_001) }).success,
    ).toBe(false)
    expect(
      agentProgressEventSchema.safeParse({ kind: 'progress', message: 'm', percent: 101 }).success,
    ).toBe(false)
    expect(
      agentProgressEventSchema.safeParse({ kind: 'progress', message: 'm', percent: 0 }).success,
    ).toBe(true)
  })

  it('caps serialized data at 4 KiB', () => {
    const small = { kind: 'progress', message: 'm', data: { note: 'ok' } }
    expect(agentProgressEventSchema.safeParse(small).success).toBe(true)
    const big = {
      kind: 'progress',
      message: 'm',
      data: { blob: 'x'.repeat(AGENT_PROGRESS_DATA_MAX_BYTES) },
    }
    expect(agentProgressEventSchema.safeParse(big).success).toBe(false)
  })
})

describe('listAgentProgressRequestSchema (TASK-126)', () => {
  it('accepts runId alone and rejects extra keys / over-limit pages', () => {
    expect(listAgentProgressRequestSchema.safeParse({ runId: 'run-1' }).success).toBe(true)
    expect(
      listAgentProgressRequestSchema.safeParse({ runId: 'run-1', afterSeq: 4, limit: 50 }).success,
    ).toBe(true)
    expect(listAgentProgressRequestSchema.safeParse({ runId: 'run-1', extra: true }).success).toBe(
      false,
    )
    expect(
      listAgentProgressRequestSchema.safeParse({ runId: 'run-1', limit: 10_000 }).success,
    ).toBe(false)
  })
})
