import { randomUUID } from 'node:crypto'

import {
  DEFAULT_ITERATION_POLICY,
  type IpcResult,
  type IterationPolicy,
  type Task,
  type WorkflowDefinition,
  type WorkflowIterateRequest,
  type WorkflowIterateResult,
  type WorkflowIterateStopReason,
  type WorkflowRun,
  type WorkflowRunDetail,
  type WorkflowStep,
  type WorkbenchEvents,
} from '@teskra/contracts'

import type { AgentRegistry } from '../agents/agent-registry'
import type { CriteriaRepository } from '../db/repositories/criteria-repository'
import type { HandoffRepository } from '../db/repositories/handoff-repository'
import type { TaskRepository } from '../db/repositories/task-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { TeskraPaths } from '../paths'
import type { PromptTemplateService } from '../prompts/prompt-template-service'
import type { TaskManager } from '../tasks/task-manager'
import type { WorkspaceRuntime } from '../workspace/runtime'
import type { WorkflowEngine } from './workflow-engine'
import type { WorkflowRunStore } from './workflow-run-store'

/**
 * IterationController (TASK-062, teskra-tasks.md; plan §124/§153) — the
 * Iterate Primitive:
 *
 *   Implement → Review → Fail? → Fix → Review
 *
 * The WorkflowEngine deliberately has no loop; this controller drives the
 * multi-round cycle by executing ONE acyclic DAG pass per round
 * (`engine.start` → settle → evaluate → `advanceIteration` → next pass). The
 * persisted definition snapshot:
 *
 *   implement         agent, runOn 'first'
 *   fix               agent, runOn 'subsequent'
 *   review-implement  review-panel, runOn 'first',      dependsOn [implement]
 *   review-fix        review-panel, runOn 'subsequent', dependsOn [fix]
 *
 * Two review nodes because of the engine's runOn semantics (plan §153): a
 * future-phase node ('subsequent' in round 1) activates nothing, so a single
 * review node depending on both agent nodes would be skipped in round 1. With
 * this shape exactly one agent node and exactly one review node execute per
 * round — every round is its own AgentRun with its own Handoff/Artifacts.
 *
 * TASK-063: the default full workflow persists an EXTENDED snapshot (shell
 * test + criteria-gate nodes between agent and review, same node ids for
 * agent/review). The controller supports it unchanged: `resolveStepContext`
 * supplies the shell steps' runtime/cwd, and the round verdict additionally
 * requires a completed criteria-gate step with outcome 'pass' whenever the
 * snapshot declares gate nodes.
 *
 * Safety Cap (plan §124) — both limits are enforced, counters are read from
 * the DB on every decision (never held in memory), so a fresh controller
 * instance after an app restart continues with identical judgement:
 *
 * - `maxRoundsPerCriteriaVersion` (default 3) anchors to the task's currently
 *   CONFIRMED criteria set (`workflow_runs.criteria_set_id`); when the anchor
 *   changes (the user confirmed a new criteria version) `criteria_iteration`
 *   resets via `anchorCriteriaSet`.
 * - `maxTotalRounds` (default 8) accumulates across criteria versions and
 *   NEVER resets; it is derived from `current_iteration`, which
 *   `advanceIteration` keeps incrementing. The run's `total_iterations` is
 *   set to `maxTotalRounds` at creation so the store's own guard is a
 *   defense-in-depth backstop.
 *
 * When either cap triggers (plan §124 — two entities, two statuses):
 *
 *   WorkflowRun.status = needs_user_review   (引擎主动停手)
 *   Task.status        = needs_review        (等人看)
 *
 * A capped run can be resumed by calling `iterate` again with its `runId`
 * (typically after the user reviewed and confirmed a new criteria version):
 * the anchor re-resolves, the per-version counter resets, the total keeps
 * counting. Resuming WITHOUT a criteria change re-triggers the cap
 * immediately without burning another round.
 */
export interface IterationController {
  /**
   * Settles only when the loop ends — pass verdict, a triggered cap, or
   * cancellation — so the returned promise can take as long as the agents
   * involved. A failed round is NOT an IPC error; it advances the loop or
   * triggers a cap.
   */
  iterate(request: WorkflowIterateRequest): Promise<IpcResult<WorkflowIterateResult>>
}

export interface IterationControllerDeps {
  readonly runs: WorkflowRunStore
  readonly engine: WorkflowEngine
  readonly registry: Pick<AgentRegistry, 'get'>
  readonly tasks: Pick<TaskRepository, 'getById'>
  readonly taskManager: Pick<TaskManager, 'update'>
  readonly criteria: Pick<CriteriaRepository, 'listSetsByTask' | 'listCriteria'>
  readonly workspaces: Pick<WorkspaceRepository, 'getById'>
  readonly events: EventBus<WorkbenchEvents>
  /** Prompt rendering (TASK-079); without it agents run with the raw overrides. */
  readonly promptTemplates?: Pick<PromptTemplateService, 'render'>
  /** Previous-round handoff lookup for the 'fix' prompt (ADR-0004). */
  readonly handoffs?: Pick<HandoffRepository, 'getByRunId'>
  readonly paths?: TeskraPaths
  readonly createAgentRunId?: () => string
  /**
   * TASK-063: resolves the runtime + cwd shell steps execute under (TASK-058
   * requires both in the WorkflowExecutionContext). For an orchestrated run
   * this is the worktree directory in the workspace's runtime; absent → agent
   * steps only, and any shell node fails with the executor's own error.
   */
  readonly resolveStepContext?: (input: {
    workspaceId: string
    worktreeId?: string
  }) => IpcResult<{ runtime: WorkspaceRuntime; cwd: string } | undefined>
}

/** Fixed identity of the iterate definition snapshot every run persists. */
const ITERATE_DEFINITION_ID = 'iterate'
const IMPLEMENT_NODE_ID = 'implement'
const FIX_NODE_ID = 'fix'
const REVIEW_NODE_IDS = ['review-implement', 'review-fix'] as const

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled'])

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function invalid<T>(message: string, detail: string): IpcResult<T> {
  return fail({ code: 'VALIDATION_FAILED', message, retryable: false, detail })
}

function buildIterateDefinition(agent: string, reviewers: readonly string[]): WorkflowDefinition {
  return {
    id: ITERATE_DEFINITION_ID,
    description:
      'TASK-062 Iterate primitive: Implement → Review → Fix → Review (loop driven by IterationController, plan §124/§153).',
    steps: [
      { id: IMPLEMENT_NODE_ID, type: 'agent', agent, role: 'implementer', runOn: 'first' },
      { id: FIX_NODE_ID, type: 'agent', agent, role: 'fixer', runOn: 'subsequent' },
      {
        id: 'review-implement',
        type: 'review-panel',
        agents: [...reviewers],
        runOn: 'first',
        dependsOn: [IMPLEMENT_NODE_ID],
      },
      {
        id: 'review-fix',
        type: 'review-panel',
        agents: [...reviewers],
        runOn: 'subsequent',
        dependsOn: [FIX_NODE_ID],
      },
    ],
  }
}

export function createIterationController(deps: IterationControllerDeps): IterationController {
  const createAgentRunId = deps.createAgentRunId ?? randomUUID
  /** Run ids this controller is currently driving (concurrent-iterate guard). */
  const activeLoops = new Set<string>()

  const emitRunStatus = (runId: string, status: WorkflowRun['status']): void => {
    deps.events.emit('workflow.run_updated', { runId, status })
  }

  /** The task's currently confirmed criteria set id = the per-version anchor. */
  const resolveCriteriaAnchor = (taskId: string): IpcResult<string | null> => {
    const sets = deps.criteria.listSetsByTask(taskId)
    if (!sets.ok) return sets
    const confirmed = sets.data
      .filter((set) => set.status === 'confirmed')
      .sort((a, b) => b.version - a.version)[0]
    return { ok: true, data: confirmed?.id ?? null }
  }

  /**
   * The review verdict of the round that just settled: the review-panel step
   * that COMPLETED in the run's current iteration (exactly one per round; its
   * sibling is runOn-skipped). Anything but outcome 'approve' — including a
   * failed or skipped review step — fails the round.
   *
   * TASK-063: when the definition snapshot carries criteria-gate nodes, the
   * gate's verdict joins the round verdict — a review-approved round still
   * fails when the gate of the same iteration did not complete with outcome
   * 'pass'. Definitions without gate nodes (plain iterate) are unaffected.
   */
  const reviewVerdict = (detail: WorkflowRunDetail): 'approve' | 'reject' => {
    const iteration = detail.run.currentIteration
    const step = detail.steps.find(
      (entry) =>
        entry.iteration === iteration &&
        entry.nodeType === 'review-panel' &&
        entry.status === 'completed' &&
        (REVIEW_NODE_IDS as readonly string[]).includes(entry.nodeId),
    )
    if (step?.result?.['outcome'] !== 'approve') return 'reject'
    const hasGateNode = detail.run.definition.steps.some((node) => node.type === 'criteria-gate')
    if (!hasGateNode) return 'approve'
    const gate = detail.steps.find(
      (entry) =>
        entry.iteration === iteration &&
        entry.nodeType === 'criteria-gate' &&
        entry.status === 'completed',
    )
    return gate?.result?.['outcome'] === 'pass' ? 'approve' : 'reject'
  }

  /** The agent step that executed in the given iteration (implement or fix). */
  const agentStepOf = (detail: WorkflowRunDetail, iteration: number): WorkflowStep | undefined =>
    detail.steps.find(
      (entry) =>
        entry.iteration === iteration &&
        entry.nodeType === 'agent' &&
        (entry.status === 'completed' || entry.status === 'failed') &&
        (entry.nodeId === IMPLEMENT_NODE_ID || entry.nodeId === FIX_NODE_ID),
    )

  /**
   * plan §124: on cap, hand the run to the user AND mark the task. A cap
   * triggered right after a round settled (`countRound: true`) first counts
   * that round into both persisted counters, so `criteriaIteration` always
   * equals the rounds executed under the current anchor and a resume without
   * a criteria change re-triggers the cap immediately (pre-round check).
   */
  const triggerCap = (
    run: WorkflowRun,
    stopReason: WorkflowIterateStopReason,
    rounds: number,
    countRound: boolean,
  ): IpcResult<WorkflowIterateResult> => {
    let counted = run
    if (countRound) {
      const advanced = deps.runs.advanceIteration(run.id)
      if (advanced.ok) {
        counted = advanced.data
      } else {
        getLogger('runtime').warn(
          { runId: run.id, error: advanced.error },
          'Could not count the capped round; the cap decision stands.',
        )
      }
    }
    const updated = deps.runs.setRunStatus(run.id, 'needs_user_review')
    if (!updated.ok) return updated
    emitRunStatus(run.id, 'needs_user_review')
    if (counted.taskId !== undefined) {
      const task = deps.taskManager.update({ id: counted.taskId, status: 'needs_review' })
      if (!task.ok) return task
    }
    return { ok: true, data: { run: updated.data, rounds, stopReason } }
  }

  return {
    async iterate(request) {
      const policy: IterationPolicy = { ...DEFAULT_ITERATION_POLICY, ...request.policy }

      const task = deps.tasks.getById(request.taskId)
      if (!task.ok) return task
      if (task.data === null) {
        return invalid(
          `Task "${request.taskId}" was not found.`,
          `IterationController could not resolve task id=${JSON.stringify(request.taskId)}`,
        )
      }
      if (task.data.workspaceId !== request.workspaceId) {
        return invalid(
          'The task belongs to a different workspace.',
          `task workspace=${task.data.workspaceId} iterate workspace=${request.workspaceId}`,
        )
      }

      let run: WorkflowRun
      if (request.runId === undefined) {
        for (const agentId of [request.agent as string, ...(request.reviewers ?? [])]) {
          if (deps.registry.get(agentId) === undefined) {
            return invalid(
              `Agent "${agentId}" is not registered.`,
              `IterationController could not resolve agent=${JSON.stringify(agentId)}`,
            )
          }
        }
        const anchor = resolveCriteriaAnchor(request.taskId)
        if (!anchor.ok) return anchor
        const created = deps.runs.createRun({
          definition: buildIterateDefinition(request.agent as string, request.reviewers ?? []),
          taskId: request.taskId,
          totalIterations: policy.maxTotalRounds,
          ...(anchor.data === null ? {} : { criteriaSetId: anchor.data }),
        })
        if (!created.ok) return created
        run = created.data.run
      } else {
        const found = deps.runs.getRun(request.runId)
        if (!found.ok) return found
        if (found.data === null) {
          return invalid(
            `Workflow run "${request.runId}" was not found.`,
            `IterationController could not resolve run id=${JSON.stringify(request.runId)}`,
          )
        }
        if (found.data.run.taskId !== request.taskId) {
          return invalid(
            `Workflow run "${request.runId}" belongs to a different Task.`,
            `run task=${JSON.stringify(found.data.run.taskId)} iterate task=${JSON.stringify(request.taskId)}`,
          )
        }
        run = found.data.run
      }

      // A second iterate() for a run this controller is already driving must
      // not reach engine.start: the engine's duplicate-pass rejection would
      // be answered with setRunStatus('failed') below, corrupting the run the
      // active loop still owns.
      if (activeLoops.has(run.id)) {
        return invalid(
          `Workflow run "${run.id}" already has an active iterate loop.`,
          `concurrent iterate for run ${run.id}`,
        )
      }
      activeLoops.add(run.id)
      try {
        return await iterateLoop(request, run, task.data)
      } finally {
        activeLoops.delete(run.id)
      }
    },
  }

  /**
   * The multi-round loop body, run under the active-loops guard. Extracted
   * from `iterate` so the guard's try/finally brackets every return path.
   */
  async function iterateLoop(
    request: WorkflowIterateRequest,
    initialRun: WorkflowRun,
    taskRow: Task,
  ): Promise<IpcResult<WorkflowIterateResult>> {
    const policy: IterationPolicy = { ...DEFAULT_ITERATION_POLICY, ...request.policy }
    let run = initialRun
    // TASK-063: shell steps (Build/Test) need the workspace runtime and the
    // worktree cwd in the execution context; resolve them once per
    // iterate() call (the worktree binding does not change between rounds).
    let stepRuntime: WorkspaceRuntime | undefined
    let stepCwd: string | undefined
    if (deps.resolveStepContext !== undefined) {
      const stepContext = deps.resolveStepContext({
        workspaceId: request.workspaceId,
        ...(request.worktreeId === undefined ? {} : { worktreeId: request.worktreeId }),
      })
      if (!stepContext.ok) return stepContext
      stepRuntime = stepContext.data?.runtime
      stepCwd = stepContext.data?.cwd
    }

    for (;;) {
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        return invalid(
          `Workflow run "${run.id}" is ${run.status}; it cannot be iterated.`,
          `iterate on terminal run ${run.id}`,
        )
      }

      // Re-anchor to the currently confirmed criteria set: a changed anchor
      // means "the user edited the Criteria" and resets the per-version
      // counter; the total (currentIteration) never resets (plan §124).
      const anchor = resolveCriteriaAnchor(request.taskId)
      if (!anchor.ok) return anchor
      if ((run.criteriaSetId ?? null) !== anchor.data) {
        const anchored = deps.runs.anchorCriteriaSet(run.id, anchor.data)
        if (!anchored.ok) return anchored
        run = anchored.data
      }

      // Pre-round cap check (resume path): a run that already hit a cap and
      // whose criteria did NOT change re-triggers immediately instead of
      // burning another round.
      const detail = deps.runs.getRun(run.id)
      if (!detail.ok) return detail
      if (detail.data === null) {
        return invalid(
          `Workflow run "${run.id}" was not found.`,
          `run ${run.id} vanished during iteration`,
        )
      }
      const settledRounds = detail.data.steps.some(
        (step) => step.iteration === run.currentIteration,
      )
        ? run.currentIteration + 1
        : run.currentIteration
      if (settledRounds > 0) {
        if (run.criteriaIteration >= policy.maxRoundsPerCriteriaVersion) {
          return triggerCap(run, 'max_rounds_per_criteria_version', settledRounds, false)
        }
        if (settledRounds >= policy.maxTotalRounds) {
          return triggerCap(run, 'max_total_rounds', settledRounds, false)
        }
      }

      // Exactly one agent node executes per pass, so a per-round
      // pre-allocated AgentRun id is safe here (it makes the prompt's
      // ADR-0004 env paths match the run AgentManager will start).
      const agentRunId = createAgentRunId()
      const isFirstRound = run.currentIteration === 0
      let prompt = isFirstRound ? request.prompt : (request.fixPrompt ?? request.prompt)
      if (prompt === undefined && deps.promptTemplates !== undefined && deps.paths !== undefined) {
        const workspace = deps.workspaces.getById(request.workspaceId)
        if (!workspace.ok) return workspace
        if (workspace.data === null) {
          return invalid(
            `Workspace "${request.workspaceId}" was not found.`,
            `IterationController could not resolve workspace id=${JSON.stringify(request.workspaceId)}`,
          )
        }
        const anchorSetId = run.criteriaSetId
        let criteria: string[] | undefined
        if (anchorSetId !== undefined) {
          const rows = deps.criteria.listCriteria(anchorSetId)
          if (!rows.ok) return rows
          criteria = rows.data.map((criterion) => criterion.description)
        }
        let previousHandoff: string | undefined
        if (!isFirstRound && deps.handoffs !== undefined) {
          const previousRunId = agentStepOf(detail.data, run.currentIteration - 1)?.result?.[
            'agentRunId'
          ]
          if (typeof previousRunId === 'string') {
            const handoff = deps.handoffs.getByRunId(previousRunId)
            if (!handoff.ok) return handoff
            const summary = handoff.data?.payload?.['summary']
            previousHandoff = typeof summary === 'string' ? summary : undefined
          }
        }
        const runFiles = deps.paths.runFiles(agentRunId)
        if (!runFiles.ok) return runFiles
        const rendered = deps.promptTemplates.render(
          {
            name: isFirstRound ? 'implement' : 'fix',
            context: {
              task: { title: taskRow.title, description: taskRow.description ?? '' },
              ...(criteria === undefined ? {} : { criteria }),
              role: isFirstRound ? 'implementer' : 'fixer',
              ...(previousHandoff === undefined ? {} : { previousHandoff }),
              env: {
                TESKRA_HANDOFF_PATH: runFiles.data.handoff,
                TESKRA_ARTIFACT_DIR: runFiles.data.artifacts,
              },
            },
          },
          workspace.data.path,
        )
        if (!rendered.ok) return rendered
        prompt = rendered.data.content
      }

      const settled = await deps.engine.start(run.id, {
        workspaceId: request.workspaceId,
        ...(request.worktreeId === undefined ? {} : { worktreeId: request.worktreeId }),
        agentRunId,
        ...(prompt === undefined ? {} : { prompt }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(stepRuntime === undefined ? {} : { runtime: stepRuntime }),
        ...(stepCwd === undefined ? {} : { cwd: stepCwd }),
      })
      if (!settled.ok) {
        const failedRun = deps.runs.setRunStatus(run.id, 'failed')
        if (failedRun.ok) emitRunStatus(run.id, 'failed')
        return settled
      }
      run = settled.data.run

      if (run.status === 'cancelled') {
        return {
          ok: true,
          data: { run, rounds: run.currentIteration + 1, stopReason: 'cancelled' },
        }
      }

      const rounds = run.currentIteration + 1
      if (reviewVerdict(settled.data) === 'approve') {
        const completed = deps.runs.setRunStatus(run.id, 'completed')
        if (!completed.ok) return completed
        emitRunStatus(run.id, 'completed')
        return { ok: true, data: { run: completed.data, rounds, stopReason: 'passed' } }
      }

      const versionRounds = run.criteriaIteration + 1
      if (versionRounds >= policy.maxRoundsPerCriteriaVersion) {
        return triggerCap(run, 'max_rounds_per_criteria_version', rounds, true)
      }
      if (rounds >= policy.maxTotalRounds) {
        return triggerCap(run, 'max_total_rounds', rounds, true)
      }

      const advanced = deps.runs.advanceIteration(run.id)
      if (!advanced.ok) return advanced
      run = advanced.data
    }
  }
}
