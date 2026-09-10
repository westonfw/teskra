import { describe, expect, it } from 'vitest'

import {
  artifactSchema,
  listArtifactsRequestSchema,
  recordArtifactRequestSchema,
} from './artifact'

describe('artifact contracts (TASK-050)', () => {
  it('accepts a stored artifact record', () => {
    expect(
      artifactSchema.safeParse({
        id: 'a1',
        taskId: 't1',
        runId: 'r1',
        type: 'test-result',
        name: 'vitest',
        metadata: { passed: 3 },
        createdAt: '2026-09-10T00:00:00.000Z',
      }).success,
    ).toBe(true)
    expect(
      artifactSchema.safeParse({
        id: 'a1',
        taskId: 't1',
        type: 'screenshot',
        name: 'x',
        createdAt: '2026-09-10T00:00:00.000Z',
      }).success,
    ).toBe(false)
  })

  it('requires exactly one payload form when recording', () => {
    const base = { taskId: 't1', type: 'plan' as const, name: 'plan' }
    expect(recordArtifactRequestSchema.safeParse(base).success).toBe(false)
    expect(recordArtifactRequestSchema.safeParse({ ...base, content: '# Plan' }).success).toBe(true)
    expect(
      recordArtifactRequestSchema.safeParse({ ...base, runId: 'r1', filePath: 'plan.md' }).success,
    ).toBe(true)
    expect(recordArtifactRequestSchema.safeParse({ ...base, metadata: { v: 1 } }).success).toBe(
      true,
    )
    expect(
      recordArtifactRequestSchema.safeParse({ ...base, content: 'x', metadata: { v: 1 } }).success,
    ).toBe(false)
  })

  it('requires taskId or runId when listing', () => {
    expect(listArtifactsRequestSchema.safeParse({}).success).toBe(false)
    expect(listArtifactsRequestSchema.safeParse({ taskId: 't1' }).success).toBe(true)
    expect(listArtifactsRequestSchema.safeParse({ runId: 'r1', type: 'diff' }).success).toBe(true)
  })
})
