import type { CriterionResult } from '@teskra/contracts'
import { computeCriteriaReviewOutcome } from '@teskra/shared'

import type { CriteriaRepository } from '../db/repositories/criteria-repository'
import type { ReviewRepository } from '../db/repositories/review-repository'
import type { WorkflowStepExecution, WorkflowStepExecutor } from './workflow-engine'

/**
 * CriteriaGateStepExecutor (TASK-063) — resolves a workflow definition's
 * `criteria-gate` node automatically instead of parking it for an external
 * resolveStep: the gate evaluates the persisted criterion scores
 * (TASK-053/054, written by the ReviewCollector when the review panel
 * converged) against the run's anchored criteria set via
 * `computeCriteriaReviewOutcome`.
 *
 * Outcome mapping (WORKFLOW_CONDITION_OUTCOMES allows 'pass' | 'fail'):
 * 'pass' only when EVERY criterion of the anchored set scored 'pass'; a
 * required 'fail', an unreviewed criterion, or a missing criteria set all
 * yield 'fail' — an unverifiable gate never auto-passes. The full workflow's
 * gate sits behind a conditional `on: 'approve'` edge, so it runs only after
 * the review panel approved the round; the IterationController then folds the
 * gate's outcome into the round verdict.
 */

/** Latest score per criterion wins (scores are append-only per run). */
export function latestCriterionScores(
  scores: readonly { criterionId: string; result: CriterionResult; createdAt: string }[],
): { criterionId: string; result: CriterionResult }[] {
  const latest = new Map<string, { result: CriterionResult; createdAt: string }>()
  for (const score of scores) {
    const existing = latest.get(score.criterionId)
    if (existing === undefined || score.createdAt >= existing.createdAt) {
      latest.set(score.criterionId, { result: score.result, createdAt: score.createdAt })
    }
  }
  return [...latest.entries()].map(([criterionId, score]) => ({
    criterionId,
    result: score.result,
  }))
}

export function createCriteriaGateStepExecutor(deps: {
  readonly reviews: Pick<ReviewRepository, 'listScoresByTask'>
  readonly criteria: Pick<CriteriaRepository, 'listSetsByTask' | 'listCriteria'>
}): WorkflowStepExecutor {
  return {
    execute({ run, node }: WorkflowStepExecution) {
      if (node.type !== 'criteria-gate') {
        return Promise.resolve({
          outcome: 'failure',
          result: { error: 'criteria-gate executor received a non-criteria-gate node' },
        })
      }
      if (run.taskId === undefined) {
        // Scores attach to a Task's runs; a task-less run (ADR-0006) has
        // nothing to evaluate and never auto-passes.
        return Promise.resolve({
          outcome: 'fail',
          result: {
            criteriaOutcome: 'unknown',
            reason: 'A criteria-gate node requires a task-bound workflow run.',
          },
        })
      }

      // The gate evaluates the set the run is anchored to; fall back to the
      // task's currently confirmed set for runs created before anchoring.
      let setId = run.criteriaSetId
      if (setId === undefined) {
        const sets = deps.criteria.listSetsByTask(run.taskId)
        if (!sets.ok) {
          return Promise.resolve({ outcome: 'failure', result: { error: sets.error.message } })
        }
        setId = sets.data
          .filter((set) => set.status === 'confirmed')
          .sort((a, b) => b.version - a.version)[0]?.id
      }
      if (setId === undefined) {
        return Promise.resolve({
          outcome: 'fail',
          result: { criteriaOutcome: 'unknown', reason: 'The task has no confirmed criteria set.' },
        })
      }

      const criteria = deps.criteria.listCriteria(setId)
      if (!criteria.ok) {
        return Promise.resolve({ outcome: 'failure', result: { error: criteria.error.message } })
      }
      const scores = deps.reviews.listScoresByTask(run.taskId)
      if (!scores.ok) {
        return Promise.resolve({ outcome: 'failure', result: { error: scores.error.message } })
      }
      const criterionIds = new Set(criteria.data.map((criterion) => criterion.id))
      const latest = latestCriterionScores(
        scores.data.filter((score) => criterionIds.has(score.criterionId)),
      )
      const outcome = computeCriteriaReviewOutcome(criteria.data, latest)
      return Promise.resolve({
        outcome: outcome === 'pass' ? 'pass' : 'fail',
        result: {
          criteriaOutcome: outcome,
          criteriaSetId: setId,
          scored: latest.length,
          total: criteria.data.length,
        },
      })
    },
  }
}
