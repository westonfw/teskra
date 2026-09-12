import type { ReviewPanelVerdict, ReviewSeverity, ReviewVerdict } from '@teskra/contracts'

/**
 * Review Aggregator (TASK-061, teskra-tasks.md; plan §142) — the severity
 * policy that turns a converged Review Panel into a pass/block verdict.
 *
 * This is deliberately NOT majority voting: two "approve" reviewers never
 * outweigh one reviewer reporting a critical finding ("Claude: PASS, Codex:
 * PASS, Gemini: FAIL — SQL injection" must block). The policy is:
 *
 *   critical → block (a single critical finding stops the panel)
 *   high     → block
 *   medium   → block only at the configured threshold (config `review.
 *              mediumBlockThreshold`; 0 = mediums never block)
 *   low/none → pass
 *
 * A reviewer that could not complete ('unable_to_review') never counts as an
 * approval and never forces a block by itself; the coverage gap is recorded
 * in the reasons so it stays visible. Disagreements between reviewers are
 * computed at panel convergence (TASK-060) and carried in the same aggregate
 * record — this function never collapses them.
 */

export interface ReviewAggregationPolicy {
  /** Block at this many medium-severity findings; 0 disables medium blocking. */
  readonly mediumBlockThreshold: number
}

export const DEFAULT_REVIEW_AGGREGATION_POLICY: ReviewAggregationPolicy = {
  mediumBlockThreshold: 0,
}

/** Structural minimum of the plan §141 ReviewAggregate this policy reads. */
export interface ReviewAggregationInput {
  readonly findings: readonly { readonly severity: ReviewSeverity }[]
  readonly reviewers: readonly { readonly verdict: ReviewVerdict }[]
}

export interface ReviewVerdictComputation {
  readonly verdict: ReviewPanelVerdict
  /** Human-readable policy explanations, in evaluation order. */
  readonly reasons: string[]
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

export function computeReviewVerdict(
  input: ReviewAggregationInput,
  policy: ReviewAggregationPolicy,
): ReviewVerdictComputation {
  const counts: Record<ReviewSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const finding of input.findings) counts[finding.severity] += 1

  const reasons: string[] = []
  let verdict: ReviewPanelVerdict = 'pass'
  if (counts.critical > 0) {
    verdict = 'block'
    reasons.push(
      `${plural(counts.critical, 'critical finding')} reported — severity policy blocks on any critical finding.`,
    )
  }
  if (counts.high > 0) {
    verdict = 'block'
    reasons.push(
      `${plural(counts.high, 'high finding')} reported — severity policy blocks on any high finding.`,
    )
  }
  if (
    verdict === 'pass' &&
    policy.mediumBlockThreshold > 0 &&
    counts.medium >= policy.mediumBlockThreshold
  ) {
    verdict = 'block'
    reasons.push(
      `${plural(counts.medium, 'medium finding')} reaches the configured block threshold of ${String(policy.mediumBlockThreshold)}.`,
    )
  }
  if (verdict === 'pass') {
    reasons.push(
      input.findings.length === 0
        ? 'No findings reported by any reviewer.'
        : `No critical or high findings; ${plural(counts.medium, 'medium finding')} below the configured block threshold.`,
    )
  }

  const unable = input.reviewers.filter(
    (reviewer) => reviewer.verdict === 'unable_to_review',
  ).length
  if (unable > 0) {
    reasons.push(
      `${plural(unable, 'reviewer')} could not complete the review; the verdict covers completed reviews only.`,
    )
  }
  return { verdict, reasons }
}
