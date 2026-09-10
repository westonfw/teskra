import { describe, expect, it } from 'vitest'

import {
  CRITERIA_REVIEW_OUTCOMES,
  criterionScoreRecordSchema,
  listCriterionScoresRequestSchema,
  listReviewFindingsRequestSchema,
  reviewFindingRecordSchema,
} from './review'

describe('review contracts (TASK-053/054)', () => {
  it('accepts a persisted finding with file/line/criterion/evidence', () => {
    const result = reviewFindingRecordSchema.safeParse({
      id: 'f-1',
      runId: 'run-1',
      severity: 'high',
      title: 'Missing null check',
      file: 'src/api.ts',
      line: 12,
      criterionId: 'crit-1',
      evidence: ['src/api.ts:12 dereferences user.name'],
      createdAt: '2026-09-10T00:00:00.000Z',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a persisted criterion score in all three states', () => {
    for (const result of ['pass', 'fail', 'unknown'] as const) {
      const parsed = criterionScoreRecordSchema.safeParse({
        id: 's-1',
        runId: 'run-1',
        criterionId: 'crit-1',
        result,
        createdAt: '2026-09-10T00:00:00.000Z',
      })
      expect(parsed.success).toBe(true)
    }
    expect(CRITERIA_REVIEW_OUTCOMES).toEqual(['pass', 'fail', 'unknown'])
  })

  it('requires exactly one scope for list requests', () => {
    expect(listReviewFindingsRequestSchema.safeParse({ runId: 'run-1' }).success).toBe(true)
    expect(listReviewFindingsRequestSchema.safeParse({ taskId: 'task-1' }).success).toBe(true)
    expect(listReviewFindingsRequestSchema.safeParse({}).success).toBe(false)
    expect(
      listReviewFindingsRequestSchema.safeParse({ runId: 'run-1', taskId: 'task-1' }).success,
    ).toBe(false)
    expect(listCriterionScoresRequestSchema.safeParse({}).success).toBe(false)
  })
})
