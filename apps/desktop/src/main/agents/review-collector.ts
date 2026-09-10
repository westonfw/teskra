import { randomUUID } from 'node:crypto'

import { reviewFindingSchema, type ReviewFinding } from '@teskra/contracts'

import type { Handoff } from '../db/repositories/handoff-repository'
import type { AddFindingInput, ReviewRepository } from '../db/repositories/review-repository'
import { getLogger } from '../logger'

export interface ReviewCollectorDeps {
  readonly reviews: ReviewRepository
  readonly createFindingId?: () => string
  readonly now?: () => string
}

export interface ReviewCollector {
  /**
   * TASK-053 — persists a collected handoff's `findings` into
   * `review_findings`, keyed by the run that produced them.
   *
   * Best-effort like HandoffCollector itself (ADR-0004): never throws and
   * never blocks Run completion; failures are logged. Item-level degradation:
   * a handoff whose overall parse_status is 'degraded' may still carry a
   * usable findings array, so each item is validated on its own and only the
   * invalid ones are dropped. A finding whose criterionId violates the
   * acceptance_criteria FK is retried without the link rather than lost.
   *
   * Re-ingesting a run (e.g. after a resume) replaces its findings so rows
   * never duplicate.
   */
  ingest(runId: string, handoff: Handoff): void
}

interface ExtractedFindings {
  readonly findings: ReviewFinding[]
  /** Items dropped because they failed the contracts finding schema. */
  readonly dropped: number
}

function extractFindings(handoff: Handoff): ExtractedFindings | undefined {
  const raw = handoff.payload?.['findings']
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return { findings: [], dropped: 1 }
  const findings: ReviewFinding[] = []
  let dropped = 0
  for (const item of raw) {
    const parsed = reviewFindingSchema.safeParse(item)
    if (parsed.success) {
      findings.push(parsed.data)
    } else {
      dropped += 1
    }
  }
  return { findings, dropped }
}

export function createReviewCollector(deps: ReviewCollectorDeps): ReviewCollector {
  const logger = getLogger('agent')
  const createFindingId = deps.createFindingId ?? randomUUID
  const now = deps.now ?? (() => new Date().toISOString())

  return {
    ingest(runId, handoff) {
      try {
        const extracted = extractFindings(handoff)
        if (extracted === undefined) return
        if (extracted.dropped > 0) {
          logger.warn(
            { runId, dropped: extracted.dropped, parseStatus: handoff.parseStatus },
            'Dropped review findings that failed validation; the rest are persisted.',
          )
        }
        // Replace, not append: handoffs are one-per-run, findings follow.
        const cleared = deps.reviews.deleteFindingsByRun(runId)
        if (!cleared.ok) {
          logger.error(
            { runId, error: cleared.error },
            'Failed to clear stale review findings; skipping ingest.',
          )
          return
        }
        for (const finding of extracted.findings) {
          const base: AddFindingInput = {
            id: createFindingId(),
            runId,
            severity: finding.severity,
            title: finding.title,
            ...(finding.description === undefined ? {} : { description: finding.description }),
            ...(finding.file === undefined ? {} : { file: finding.file }),
            ...(finding.line === undefined ? {} : { line: finding.line }),
            ...(finding.evidence === undefined ? {} : { evidence: finding.evidence }),
          }
          let saved =
            finding.criterionId === undefined
              ? deps.reviews.addFinding(base, now())
              : deps.reviews.addFinding({ ...base, criterionId: finding.criterionId }, now())
          if (!saved.ok && finding.criterionId !== undefined) {
            logger.warn(
              { runId, criterionId: finding.criterionId, error: saved.error },
              'Finding criterion link was rejected; persisting the finding without it.',
            )
            saved = deps.reviews.addFinding(base, now())
          }
          if (!saved.ok) {
            logger.error(
              { runId, title: finding.title, error: saved.error },
              'Failed to persist a review finding.',
            )
          }
        }
      } catch (cause) {
        logger.error({ runId, cause }, 'Review finding ingest threw; the Run result is unaffected.')
      }
    },
  }
}
