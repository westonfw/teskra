import { randomUUID } from 'node:crypto'

import type {
  AcceptanceCriteriaSet,
  AcceptanceCriteriaSetDetail,
  AcceptanceCriterion,
  AddCriterionRequest,
  AgentRun,
  BindRunCriteriaRequest,
  CreateCriteriaSetRequest,
  CriteriaSetIdRequest,
  CriterionIdRequest,
  IpcResult,
  ListCriteriaSetsRequest,
  UpdateCriterionRequest,
  WorkbenchEvents,
} from '@teskra/contracts'

import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { CriteriaRepository } from '../db/repositories/criteria-repository'
import type { TaskRepository } from '../db/repositories/task-repository'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'

/**
 * CriteriaManager (TASK-048) — the AcceptanceCriteria domain service.
 *
 * State machine for a criteria set (pinned by tests):
 *
 * - `draft` — editable: criteria can be added / updated / removed.
 * - `confirmed` — immutable. Confirming requires at least one criterion and
 *   automatically supersedes every other confirmed set of the same Task, so
 *   at most one confirmed set exists per Task (the semantic MergePreflight
 *   (TASK-045) relies on when resolving a task's confirmed set).
 * - `superseded` — terminal; kept for audit because runs / workflow runs /
 *   review panels reference the exact version they were validated against.
 *
 * Editing a confirmed contract means `createSet` (a new draft at
 * version+1) followed by `confirmSet`; a set's rows are never mutated after
 * confirmation.
 *
 * `bindRun` records the confirmed version a Run is validated against in
 * `agent_runs.criteria_set_id`; MergePreflight prefers this binding over the
 * task-level fallback.
 */
export interface CriteriaManager {
  listSets(request: ListCriteriaSetsRequest): IpcResult<AcceptanceCriteriaSet[]>
  getSet(request: CriteriaSetIdRequest): IpcResult<AcceptanceCriteriaSetDetail | null>
  createSet(request: CreateCriteriaSetRequest): IpcResult<AcceptanceCriteriaSetDetail>
  addCriterion(request: AddCriterionRequest): IpcResult<AcceptanceCriterion>
  updateCriterion(request: UpdateCriterionRequest): IpcResult<AcceptanceCriterion>
  removeCriterion(request: CriterionIdRequest): IpcResult<boolean>
  confirmSet(request: CriteriaSetIdRequest): IpcResult<AcceptanceCriteriaSet>
  supersedeSet(request: CriteriaSetIdRequest): IpcResult<AcceptanceCriteriaSet>
  bindRun(request: BindRunCriteriaRequest): IpcResult<AgentRun>
}

export interface CriteriaManagerDeps {
  readonly criteria: CriteriaRepository
  readonly tasks: TaskRepository
  readonly runs: AgentRunRepository
  readonly events: EventBus<WorkbenchEvents>
  readonly createId?: () => string
  readonly now?: () => string
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function invalid<T>(message: string, detail: string): IpcResult<T> {
  return fail({ code: 'VALIDATION_FAILED', message, retryable: false, detail })
}

function missingSet<T>(setId: string): IpcResult<T> {
  return invalid(
    `Criteria set "${setId}" was not found.`,
    `CriteriaManager could not resolve criteria set id=${JSON.stringify(setId)}`,
  )
}

function missingCriterion<T>(criterionId: string): IpcResult<T> {
  return invalid(
    `Criterion "${criterionId}" was not found.`,
    `CriteriaManager could not resolve criterion id=${JSON.stringify(criterionId)}`,
  )
}

export function createCriteriaManager(deps: CriteriaManagerDeps): CriteriaManager {
  const createId = deps.createId ?? randomUUID
  const now = deps.now ?? (() => new Date().toISOString())

  const requireSet = (setId: string): IpcResult<AcceptanceCriteriaSet> => {
    const found = deps.criteria.getSetById(setId)
    if (!found.ok) return found
    return found.data === null ? missingSet(setId) : { ok: true, data: found.data }
  }

  const requireDraftSet = (setId: string): IpcResult<AcceptanceCriteriaSet> => {
    const found = requireSet(setId)
    if (!found.ok) return found
    return found.data.status === 'draft'
      ? found
      : invalid(
          `Criteria set "${setId}" is ${found.data.status} and can no longer be edited; create a new version instead.`,
          `attempted to mutate ${found.data.status} criteria set id=${JSON.stringify(setId)}`,
        )
  }

  const detail = (set: AcceptanceCriteriaSet): IpcResult<AcceptanceCriteriaSetDetail> => {
    const criteria = deps.criteria.listCriteria(set.id)
    if (!criteria.ok) return criteria
    return { ok: true, data: { set, criteria: criteria.data } }
  }

  const touchTask = (taskId: string | undefined): void => {
    // Orphaned sets (ADR-0008) have no task to notify.
    if (taskId === undefined) return
    deps.events.emit('task.updated', { taskId })
  }

  return {
    listSets({ taskId }) {
      return deps.criteria.listSetsByTask(taskId)
    },

    getSet({ setId }) {
      const found = deps.criteria.getSetById(setId)
      if (!found.ok) return found
      return found.data === null ? { ok: true, data: null } : detail(found.data)
    },

    createSet({ taskId }) {
      const task = deps.tasks.getById(taskId)
      if (!task.ok) return task
      if (task.data === null) {
        return invalid(
          `Task "${taskId}" was not found.`,
          `CriteriaManager could not resolve task id=${JSON.stringify(taskId)}`,
        )
      }
      const latest = deps.criteria.getLatestSet(taskId)
      if (!latest.ok) return latest
      const created = deps.criteria.createSet(
        { id: createId(), taskId, version: (latest.data?.version ?? 0) + 1 },
        now(),
      )
      if (!created.ok) return created
      touchTask(taskId)
      return detail(created.data)
    },

    addCriterion({ setId, description, category, required }) {
      const set = requireDraftSet(setId)
      if (!set.ok) return set
      const existing = deps.criteria.listCriteria(setId)
      if (!existing.ok) return existing
      const ordinal =
        existing.data.reduce((max, criterion) => Math.max(max, criterion.ordinal), 0) + 1
      const created = deps.criteria.addCriterion(
        {
          id: createId(),
          criteriaSetId: setId,
          ordinal,
          description,
          ...(category === undefined ? {} : { category }),
          ...(required === undefined ? {} : { required }),
        },
        now(),
      )
      if (created.ok) touchTask(set.data.taskId)
      return created
    },

    updateCriterion({ criterionId, description, category, required, ordinal }) {
      const criterion = deps.criteria.getCriterionById(criterionId)
      if (!criterion.ok) return criterion
      if (criterion.data === null) return missingCriterion(criterionId)
      const set = requireDraftSet(criterion.data.criteriaSetId)
      if (!set.ok) return set
      const updated = deps.criteria.updateCriterion(criterionId, {
        ...(description === undefined ? {} : { description }),
        ...(category === undefined ? {} : { category }),
        ...(required === undefined ? {} : { required }),
        ...(ordinal === undefined ? {} : { ordinal }),
      })
      if (!updated.ok) return updated
      if (updated.data === null) return missingCriterion(criterionId)
      touchTask(set.data.taskId)
      return { ok: true, data: updated.data }
    },

    removeCriterion({ criterionId }) {
      const criterion = deps.criteria.getCriterionById(criterionId)
      if (!criterion.ok) return criterion
      if (criterion.data === null) return missingCriterion(criterionId)
      const set = requireDraftSet(criterion.data.criteriaSetId)
      if (!set.ok) return set
      const removed = deps.criteria.deleteCriterion(criterionId)
      if (removed.ok && removed.data) touchTask(set.data.taskId)
      return removed
    },

    confirmSet({ setId }) {
      const set = requireSet(setId)
      if (!set.ok) return set
      if (set.data.status !== 'draft') {
        return invalid(
          `Criteria set "${setId}" is ${set.data.status}; only a draft can be confirmed.`,
          `attempted to confirm ${set.data.status} criteria set id=${JSON.stringify(setId)}`,
        )
      }
      const criteria = deps.criteria.listCriteria(setId)
      if (!criteria.ok) return criteria
      if (criteria.data.length === 0) {
        return invalid(
          'A criteria set cannot be confirmed while it is empty.',
          `criteria set id=${JSON.stringify(setId)} has no criteria`,
        )
      }
      // Orphaned sets (ADR-0008) have no task siblings to supersede.
      if (set.data.taskId !== undefined) {
        const siblings = deps.criteria.listSetsByTask(set.data.taskId)
        if (!siblings.ok) return siblings
        for (const sibling of siblings.data) {
          if (sibling.id !== setId && sibling.status === 'confirmed') {
            const superseded = deps.criteria.supersedeSet(sibling.id)
            if (!superseded.ok) return superseded
          }
        }
      }
      const confirmed = deps.criteria.confirmSet(setId, now())
      if (!confirmed.ok) return confirmed
      if (confirmed.data === null) return missingSet(setId)
      touchTask(set.data.taskId)
      return { ok: true, data: confirmed.data }
    },

    supersedeSet({ setId }) {
      const set = requireSet(setId)
      if (!set.ok) return set
      if (set.data.status !== 'confirmed') {
        return invalid(
          `Criteria set "${setId}" is ${set.data.status}; only a confirmed set can be superseded.`,
          `attempted to supersede ${set.data.status} criteria set id=${JSON.stringify(setId)}`,
        )
      }
      const superseded = deps.criteria.supersedeSet(setId)
      if (!superseded.ok) return superseded
      if (superseded.data === null) return missingSet(setId)
      touchTask(set.data.taskId)
      return { ok: true, data: superseded.data }
    },

    bindRun({ runId, setId }) {
      const run = deps.runs.getById(runId)
      if (!run.ok) return run
      if (run.data === null) {
        return invalid(
          `Agent run "${runId}" was not found.`,
          `CriteriaManager could not resolve agent run id=${JSON.stringify(runId)}`,
        )
      }
      if (setId !== null) {
        const set = requireSet(setId)
        if (!set.ok) return set
        if (set.data.status !== 'confirmed') {
          return invalid(
            `Criteria set "${setId}" is ${set.data.status}; a run can only bind a confirmed set.`,
            `attempted to bind run id=${JSON.stringify(runId)} to ${set.data.status} criteria set id=${JSON.stringify(setId)}`,
          )
        }
        if (run.data.taskId !== undefined && run.data.taskId !== set.data.taskId) {
          return invalid(
            `Criteria set "${setId}" belongs to a different Task than run "${runId}".`,
            `run id=${JSON.stringify(runId)} taskId=${JSON.stringify(run.data.taskId)} != criteria set taskId=${JSON.stringify(set.data.taskId)}`,
          )
        }
      }
      const updated = deps.runs.update(runId, { criteriaSetId: setId }, now())
      if (!updated.ok) return updated
      if (updated.data === null) {
        return invalid(
          `Agent run "${runId}" was not found.`,
          `CriteriaManager could not update agent run id=${JSON.stringify(runId)}`,
        )
      }
      return { ok: true, data: updated.data }
    },
  }
}
