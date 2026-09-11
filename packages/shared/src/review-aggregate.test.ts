import { describe, expect, it } from 'vitest'

import type { ReviewSeverity, ReviewVerdict } from '@teskra/contracts'

import {
  computeReviewVerdict,
  DEFAULT_REVIEW_AGGREGATION_POLICY,
  type ReviewAggregationInput,
} from './review-aggregate'

/** TASK-061 acceptance: severity policy, not majority voting. */

function input(
  severities: readonly ReviewSeverity[],
  verdicts: readonly ReviewVerdict[] = ['approve'],
): ReviewAggregationInput {
  return {
    findings: severities.map((severity) => ({ severity })),
    reviewers: verdicts.map((verdict) => ({ verdict })),
  }
}

describe('computeReviewVerdict', () => {
  it('blocks on a single critical finding', () => {
    const result = computeReviewVerdict(input(['critical']), DEFAULT_REVIEW_AGGREGATION_POLICY)
    expect(result.verdict).toBe('block')
    expect(result.reasons.join(' ')).toContain('critical')
  })

  it('blocks on high findings', () => {
    const result = computeReviewVerdict(input(['high']), DEFAULT_REVIEW_AGGREGATION_POLICY)
    expect(result.verdict).toBe('block')
    expect(result.reasons.join(' ')).toContain('high')
  })

  it('is NOT majority voting: two approves never outweigh one critical', () => {
    const result = computeReviewVerdict(
      input(['critical'], ['approve', 'approve', 'changes_requested']),
      DEFAULT_REVIEW_AGGREGATION_POLICY,
    )
    expect(result.verdict).toBe('block')
  })

  it('passes with only low findings or no findings at all', () => {
    expect(
      computeReviewVerdict(input(['low', 'low']), DEFAULT_REVIEW_AGGREGATION_POLICY).verdict,
    ).toBe('pass')
    expect(computeReviewVerdict(input([]), DEFAULT_REVIEW_AGGREGATION_POLICY).verdict).toBe('pass')
    expect(computeReviewVerdict(input([]), DEFAULT_REVIEW_AGGREGATION_POLICY).reasons[0]).toContain(
      'No findings',
    )
  })

  it('medium findings block only at the configured threshold', () => {
    const policy = { mediumBlockThreshold: 3 }
    expect(computeReviewVerdict(input(['medium', 'medium']), policy).verdict).toBe('pass')
    expect(computeReviewVerdict(input(['medium', 'medium', 'medium']), policy).verdict).toBe(
      'block',
    )
    expect(
      computeReviewVerdict(input(['medium', 'medium', 'medium', 'medium']), policy).verdict,
    ).toBe('block')
  })

  it('medium findings never block when the threshold is 0 (default)', () => {
    const result = computeReviewVerdict(
      input(['medium', 'medium', 'medium', 'medium', 'medium']),
      DEFAULT_REVIEW_AGGREGATION_POLICY,
    )
    expect(result.verdict).toBe('pass')
    expect(result.reasons.join(' ')).toContain('below the configured block threshold')
  })

  it('flags reviewers that could not complete without letting them approve or block', () => {
    const passing = computeReviewVerdict(
      input([], ['approve', 'unable_to_review']),
      DEFAULT_REVIEW_AGGREGATION_POLICY,
    )
    expect(passing.verdict).toBe('pass')
    expect(passing.reasons.join(' ')).toContain('could not complete')

    const blocked = computeReviewVerdict(
      input(['high'], ['unable_to_review', 'changes_requested']),
      DEFAULT_REVIEW_AGGREGATION_POLICY,
    )
    expect(blocked.verdict).toBe('block')
  })

  it('lists every blocking reason when several severities trip the policy', () => {
    const result = computeReviewVerdict(input(['critical', 'critical', 'high']), {
      mediumBlockThreshold: 1,
    })
    expect(result.verdict).toBe('block')
    expect(result.reasons.filter((reason) => reason.includes('blocks on any'))).toHaveLength(2)
  })
})
