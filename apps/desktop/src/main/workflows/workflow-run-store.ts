import { randomUUID } from 'node:crypto'

import type {
  IpcResult,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepStatus,
} from '@teskra/contracts'
import { normalizeDependsOn, validateWorkflowDefinition } from '@teskra/shared'

import type { TaskRepository } from '../db/repositories/task-repository'
import type {
  WorkflowRunRepository,
  CreateWorkflowRunInput,
} from '../db/repositories/workflow-run-repository'
import { type InternalAppError, toPublicError } from '../errors'

/**
 * WorkflowRunStore (TASK-056) — the domain service over WorkflowRunRepository
 * (Manager 层不直接写 SQL).
 *
 * - A run binds a VALIDATED definition snapshot at creation time
 *   (`definition_json`), so a restart can interpret the run even if the
 *   repo-local definition file changed afterwards.
 * - A run may belong to no Task at all (ADR-0006).
 * - Steps follow a state machine (see STEP_TRANSITIONS); illegal transitions
 *   are rejected, never silently applied.
 * - Iterations are recorded on the run (`currentIteration` / `totalIterations`)
 *   and on every step (`iteration`); the same node id yields one step row per
 *   iteration — that is the expected shape (plan §153).
 * - The store holds NO in-memory state: every read goes to the repository, so
 *   constructing a fresh instance over the same database fully recovers the
 *   state after an app restart.
 */

export interface CreateWorkflowRunRequest {
  /** Raw definition input; validated before it becomes the snapshot. */
  readonly definition: unknown
  /** Defaults to the validated definition's own id. */
  readonly workflowDefinitionId?: string
  readonly taskId?: string
  readonly totalIterations?: number
  readonly criteriaSetId?: string
}

export interface ListWorkflowRunsFilter {
  readonly taskId?: string
  readonly status?: WorkflowRunStatus
}

export interface TransitionStepOptions {
  readonly result?: Record<string, unknown>
}

export interface WorkflowRunStore {
  createRun(request: CreateWorkflowRunRequest): IpcResult<WorkflowRunDetail>
  getRun(runId: string): IpcResult<WorkflowRunDetail | null>
  listRuns(filter?: ListWorkflowRunsFilter): IpcResult<WorkflowRun[]>
  /**
   * Records a step for a node of the run's definition snapshot in the run's
   * current iteration, starting in 'pending'.
   */
  addStep(runId: string, nodeId: string, options?: { attempt?: number }): IpcResult<WorkflowStep>
  transitionStep(
    stepId: string,
    to: WorkflowStepStatus,
    options?: TransitionStepOptions,
  ): IpcResult<WorkflowStep>
  /** Moves the run to the next iteration (currentIteration + 1). */
  advanceIteration(runId: string): IpcResult<WorkflowRun>
  setRunStatus(runId: string, status: WorkflowRunStatus): IpcResult<WorkflowRun>
}

export interface WorkflowRunStoreDeps {
  readonly workflowRuns: WorkflowRunRepository
  /** When provided, a supplied taskId must reference an existing Task. */
  readonly tasks?: Pick<TaskRepository, 'getById'>
  readonly createId?: () => string
  readonly now?: () => string
}

/** §139.1 workflow_steps.status state machine; terminal states have no exits. */
export const STEP_TRANSITIONS: Readonly<Record<WorkflowStepStatus, readonly WorkflowStepStatus[]>> =
  {
    pending: ['running', 'skipped', 'cancelled'],
    running: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    skipped: [],
    cancelled: [],
  }

const TERMINAL_STEP_STATUSES: ReadonlySet<WorkflowStepStatus> = new Set([
  'completed',
  'failed',
  'skipped',
  'cancelled',
])

const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
])

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function invalid<T>(message: string, detail: string): IpcResult<T> {
  return fail({ code: 'VALIDATION_FAILED', message, retryable: false, detail })
}

export function createWorkflowRunStore(deps: WorkflowRunStoreDeps): WorkflowRunStore {
  const createId = deps.createId ?? randomUUID
  const now = deps.now ?? (() => new Date().toISOString())
  const runs = deps.workflowRuns

  const requireRun = (runId: string): IpcResult<WorkflowRun> => {
    const found = runs.getRunById(runId)
    if (!found.ok) return found
    if (found.data === null) {
      return invalid(
        `Workflow run "${runId}" was not found.`,
        `WorkflowRunStore could not resolve run id=${JSON.stringify(runId)}`,
      )
    }
    return { ok: true, data: found.data }
  }

  /** An update target we just read cannot vanish; a null read-back is an internal inconsistency. */
  const requireUpdated = <T>(
    result: IpcResult<T | null>,
    entity: string,
    id: string,
  ): IpcResult<T> => {
    if (!result.ok) return result
    if (result.data === null) {
      return fail({
        code: 'UNKNOWN',
        message: `Failed to update the workflow ${entity}.`,
        retryable: true,
        detail: `${entity} ${id} missing immediately after update`,
      })
    }
    return { ok: true, data: result.data }
  }

  const store: WorkflowRunStore = {
    createRun(request) {
      const validated = validateWorkflowDefinition(request.definition)
      if (!validated.ok) {
        return invalid(
          'The workflow definition is invalid; the run was not created.',
          `definition issues: ${validated.issues.map((issue) => issue.message).join('; ')}`,
        )
      }
      const definition: WorkflowDefinition = validated.definition

      if (request.taskId !== undefined && deps.tasks !== undefined) {
        const task = deps.tasks.getById(request.taskId)
        if (!task.ok) return task
        if (task.data === null) {
          return invalid(
            `Task "${request.taskId}" was not found.`,
            `WorkflowRunStore could not resolve task id=${JSON.stringify(request.taskId)}`,
          )
        }
      }

      const input: CreateWorkflowRunInput = {
        id: createId(),
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        workflowDefinitionId: request.workflowDefinitionId ?? definition.id,
        definition,
        ...(request.totalIterations === undefined
          ? {}
          : { totalIterations: request.totalIterations }),
        ...(request.criteriaSetId === undefined ? {} : { criteriaSetId: request.criteriaSetId }),
      }
      const created = runs.createRun(input, now())
      if (!created.ok) return created
      return { ok: true, data: { run: created.data, steps: [] } }
    },

    getRun(runId) {
      const found = runs.getRunById(runId)
      if (!found.ok) return found
      if (found.data === null) return { ok: true, data: null }
      const steps = runs.listSteps(runId)
      if (!steps.ok) return steps
      return { ok: true, data: { run: found.data, steps: steps.data } }
    },

    listRuns(filter = {}) {
      return filter.taskId === undefined
        ? runs.listRuns(filter.status)
        : runs.listRunsByTask(filter.taskId, filter.status)
    },

    addStep(runId, nodeId, options = {}) {
      const run = requireRun(runId)
      if (!run.ok) return run
      if (TERMINAL_RUN_STATUSES.has(run.data.status)) {
        return invalid(
          `Workflow run "${runId}" is ${run.data.status}; no steps can be added.`,
          `addStep node=${JSON.stringify(nodeId)} on terminal run ${runId}`,
        )
      }
      const node = run.data.definition.steps.find((entry) => entry.id === nodeId)
      if (node === undefined) {
        return invalid(
          `Workflow run "${runId}" has no node "${nodeId}" in its definition snapshot.`,
          `definition ${run.data.workflowDefinitionId} nodes: ${run.data.definition.steps.map((entry) => entry.id).join(', ')}`,
        )
      }
      return runs.createStep(
        {
          id: createId(),
          workflowRunId: runId,
          nodeId,
          nodeType: node.type,
          iteration: run.data.currentIteration,
          ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
          dependsOn: normalizeDependsOn(node.dependsOn).map((dependency) => dependency.node),
        },
        now(),
      )
    },

    transitionStep(stepId, to, options = {}) {
      const found = runs.getStepById(stepId)
      if (!found.ok) return found
      if (found.data === null) {
        return invalid(
          `Workflow step "${stepId}" was not found.`,
          `WorkflowRunStore could not resolve step id=${JSON.stringify(stepId)}`,
        )
      }
      const step = found.data
      if (!STEP_TRANSITIONS[step.status].includes(to)) {
        return invalid(
          `Workflow step "${stepId}" cannot transition from "${step.status}" to "${to}".`,
          `allowed from "${step.status}": ${STEP_TRANSITIONS[step.status].join(', ') || '(terminal)'}`,
        )
      }
      const timestamp = now()
      return requireUpdated(
        runs.updateStep(stepId, {
          status: to,
          ...(to === 'running' ? { startedAt: timestamp } : {}),
          ...(TERMINAL_STEP_STATUSES.has(to) ? { finishedAt: timestamp } : {}),
          ...(options.result === undefined ? {} : { result: options.result }),
        }),
        'step',
        stepId,
      )
    },

    advanceIteration(runId) {
      const run = requireRun(runId)
      if (!run.ok) return run
      if (TERMINAL_RUN_STATUSES.has(run.data.status)) {
        return invalid(
          `Workflow run "${runId}" is ${run.data.status}; the iteration cannot advance.`,
          `advanceIteration on terminal run ${runId}`,
        )
      }
      const next = run.data.currentIteration + 1
      if (run.data.totalIterations > 0 && next > run.data.totalIterations) {
        return invalid(
          `Workflow run "${runId}" already reached its iteration limit (${String(run.data.totalIterations)}).`,
          `advanceIteration: current=${String(run.data.currentIteration)}, total=${String(run.data.totalIterations)}`,
        )
      }
      return requireUpdated(runs.updateRun(runId, { currentIteration: next }), 'run', runId)
    },

    setRunStatus(runId, status) {
      const run = requireRun(runId)
      if (!run.ok) return run
      return requireUpdated(
        runs.updateRun(runId, {
          status,
          ...(TERMINAL_RUN_STATUSES.has(status) ? { completedAt: now() } : {}),
        }),
        'run',
        runId,
      )
    },
  }

  return store
}
