import { randomUUID } from 'node:crypto'

import type { AgentRun, CriterionResult } from '@teskra/contracts'
import {
  handoffCriterionScoreSchema,
  reviewFindingSchema,
  type HandoffCriterionScore,
  type ReviewFinding,
} from '@teskra/contracts'

import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { CriteriaRepository } from '../db/repositories/criteria-repository'
import type { Handoff } from '../db/repositories/handoff-repository'
import type { AddFindingInput, ReviewRepository } from '../db/repositories/review-repository'
import { getLogger } from '../logger'

export interface ReviewCollectorDeps {
  readonly reviews: ReviewRepository
  readonly runs: AgentRunRepository
  readonly criteria: CriteriaRepository
  readonly createFindingId?: () => string
  readonly createScoreId?: () => string
  readonly now?: () => string
}

export interface ReviewCollector {
  /**
   * TASK-053/054 — persists a collected handoff's review payload:
   * `findings` into `review_findings` and `criterionScores` into
   * `criterion_scores`.
   *
   * Best-effort like HandoffCollector itself (ADR-0004): never throws and
   * never blocks Run completion; failures are logged. Item-level degradation:
   * a handoff whose overall parse_status is 'degraded' may still carry usable
   * arrays, so each item is validated on its own and only the invalid ones
   * are dropped. A finding whose criterionId violates the acceptance_criteria
   * FK is retried without the link rather than lost.
   *
   * Scores (TASK-054): when the handoff carries `criterionScores`, every
   * criterion of the resolved CONFIRMED set gets a row — entries the reviewer
   * omitted are recorded as 'unknown' (an unreviewed criterion is never an
   * implicit pass). Scores are attributed to the handoff's `targetRunId` (the
   * reviewed implement Run, which merge preflight inspects) when it resolves
   * to a Run of the same workspace; otherwise they stay on the producing Run.
   *
   * Re-ingesting a run replaces its findings so rows never duplicate; scores
   * upsert on (run_id, criterion_id) by construction.
   */
  ingest(runId: string, handoff: Handoff): void
}

interface Extracted<T> {
  readonly items: T[]
  /** Items dropped because they failed the contracts schema. */
  readonly dropped: number
}

function extractItems<T>(
  payload: Handoff['payload'],
  key: 'findings' | 'criterionScores',
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
): Extracted<T> | undefined {
  const raw = payload?.[key]
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return { items: [], dropped: 1 }
  const items: T[] = []
  let dropped = 0
  for (const item of raw) {
    const parsed = schema.safeParse(item)
    if (parsed.success && parsed.data !== undefined) {
      items.push(parsed.data)
    } else {
      dropped += 1
    }
  }
  return { items, dropped }
}

/** Mirrors MergePreflightService: only a confirmed set is a review contract. */
function resolveCriteriaSetId(
  deps: Pick<ReviewCollectorDeps, 'criteria'>,
  run: AgentRun,
): string | undefined {
  if (run.criteriaSetId !== undefined) {
    const set = deps.criteria.getSetById(run.criteriaSetId)
    return set.ok && set.data?.status === 'confirmed' ? set.data.id : undefined
  }
  if (run.taskId === undefined) return undefined
  const sets = deps.criteria.listSetsByTask(run.taskId)
  if (!sets.ok) return undefined
  return sets.data.find((candidate) => candidate.status === 'confirmed')?.id
}

const UNREVIEWED_EVIDENCE = ['The reviewer did not report a result for this criterion.']

export function createReviewCollector(deps: ReviewCollectorDeps): ReviewCollector {
  const logger = getLogger('agent')
  const createFindingId = deps.createFindingId ?? randomUUID
  const createScoreId = deps.createScoreId ?? randomUUID
  const now = deps.now ?? (() => new Date().toISOString())

  const ingestFindings = (runId: string, handoff: Handoff): void => {
    const extracted = extractItems<ReviewFinding>(handoff.payload, 'findings', {
      safeParse: (value) => reviewFindingSchema.safeParse(value),
    })
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
    for (const finding of extracted.items) {
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
  }

  const resolveScoreRunId = (runId: string, handoff: Handoff, run: AgentRun): string => {
    const targetRunId = handoff.payload?.['targetRunId']
    if (typeof targetRunId !== 'string' || targetRunId.length === 0) return runId
    const target = deps.runs.getById(targetRunId)
    if (
      !target.ok ||
      target.data === null ||
      target.data.workspaceId !== run.workspaceId ||
      (run.taskId !== undefined && target.data.taskId !== run.taskId)
    ) {
      logger.warn(
        { runId, targetRunId },
        'Review handoff target Run did not resolve; scores stay on the reviewer Run.',
      )
      return runId
    }
    return targetRunId
  }

  const ingestScores = (runId: string, handoff: Handoff): void => {
    const extracted = extractItems<HandoffCriterionScore>(handoff.payload, 'criterionScores', {
      safeParse: (value) => handoffCriterionScoreSchema.safeParse(value),
    })
    if (extracted === undefined) return
    if (extracted.dropped > 0) {
      logger.warn(
        { runId, dropped: extracted.dropped, parseStatus: handoff.parseStatus },
        'Dropped criterion scores that failed validation; the rest are persisted.',
      )
    }
    const run = deps.runs.getById(runId)
    if (!run.ok || run.data === null) {
      logger.error(
        { runId, error: run.ok ? undefined : run.error },
        'Cannot score criteria: the producing Run is gone.',
      )
      return
    }
    const criteriaSetId = resolveCriteriaSetId(deps, run.data)
    if (criteriaSetId === undefined) {
      logger.warn({ runId }, 'No confirmed acceptance criteria set; skipping criterion scores.')
      return
    }
    const criteria = deps.criteria.listCriteria(criteriaSetId)
    if (!criteria.ok) {
      logger.error(
        { runId, criteriaSetId, error: criteria.error },
        'Cannot score criteria: failed to read the criteria set.',
      )
      return
    }

    const known = new Set(criteria.data.map((criterion) => criterion.id))
    const reported = new Map<string, HandoffCriterionScore>()
    for (const entry of extracted.items) {
      if (!known.has(entry.criterionId)) {
        logger.warn(
          { runId, criterionId: entry.criterionId, criteriaSetId },
          'Score references a criterion outside the resolved set; dropped.',
        )
        continue
      }
      reported.set(entry.criterionId, entry)
    }

    const scoreRunId = resolveScoreRunId(runId, handoff, run.data)
    for (const criterion of criteria.data) {
      const entry = reported.get(criterion.id)
      const result: CriterionResult = entry?.result ?? 'unknown'
      const recorded = deps.reviews.recordScore(
        {
          id: createScoreId(),
          runId: scoreRunId,
          criterionId: criterion.id,
          result,
          evidence: entry?.evidence ?? UNREVIEWED_EVIDENCE,
        },
        now(),
      )
      if (!recorded.ok) {
        logger.error(
          { runId: scoreRunId, criterionId: criterion.id, error: recorded.error },
          'Failed to persist a criterion score.',
        )
      }
    }
  }

  return {
    ingest(runId, handoff) {
      try {
        ingestFindings(runId, handoff)
        ingestScores(runId, handoff)
      } catch (cause) {
        logger.error({ runId, cause }, 'Review ingest threw; the Run result is unaffected.')
      }
    },
  }
}
