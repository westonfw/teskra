import type {
  AgentWorkflowNode,
  IpcResult,
  StartAgentRunRequest,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowStep,
  WorkflowStepStatus,
  WorkbenchEvents,
} from '@teskra/contracts'
import {
  activeNodeIdsForIteration,
  normalizeDependsOn,
  WORKFLOW_CONDITION_OUTCOMES,
  type NormalizedDependency,
} from '@teskra/shared'

import type { AgentManager } from '../agents/agent-manager'
import type { ProfileAliasManager } from '../agents/profile-alias-manager'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { WorkspaceRuntime } from '../workspace/runtime'
import type { WorkflowRunStore } from './workflow-run-store'

/**
 * WorkflowEngine (TASK-057; plan §153「调度语义」) — executes ONE acyclic DAG
 * pass over a WorkflowRun's current iteration. It deliberately does NOT loop:
 * the outer IterationController (TASK-062) drives multiple rounds by calling
 * `advanceIteration` + `start` again.
 *
 * Scheduling semantics (plan §153, must-implement):
 *
 * - A node runs once ALL of its `dependsOn` edges are activated.
 * - An unconditional edge activates when the upstream node COMPLETED (any
 *   outcome). A failed upstream does not activate it, so failure turns the
 *   downstream chain `skipped` — that is how failure propagates.
 * - A conditional edge `{ node, on }` activates only when the upstream's
 *   effective outcome equals `on`; an edge that never activates sends its
 *   downstream to `skipped` instead of leaving it pending forever.
 * - `skipped` propagates down the DAG through the same rule (a skipped node
 *   activates nothing).
 * - runOn filtering happens at pass start: filtered nodes become `skipped`
 *   immediately. A node filtered because its phase is in the PAST
 *   (`runOn: 'first'` in iteration > 1) counts as completed — its out-edges
 *   activate as usual, so e.g. `test` is not blocked waiting for `implement`
 *   in round 2. A node filtered because its phase is in the FUTURE
 *   (`runOn: 'subsequent'` in iteration 1) activates nothing, so its
 *   exclusive downstream skips too (expected behavior per plan §153).
 * - Scheduling is event-driven: `schedule()` runs only on pass start, on an
 *   executor settling, on `resolveStep`, and on `cancel`. The graph is
 *   acyclic (enforced by validateWorkflowDefinition at load), so every pass
 *   terminates — there is no polling and no infinite scheduling.
 *
 * Node-type dispatch:
 *
 * - `agent` runs through AgentManager (injected or the default executor
 *   here). ADR-0002 red line: orchestrated runs require a worktree — the
 *   default executor only requests `orchestrated` when the context carries a
 *   `worktreeId`, and AgentManager.start rejects the rest.
 * - `checkpoint` / `criteria-gate` / `review-panel` need human or external
 *   input: the step is parked in `running` until someone calls
 *   `resolveStep` (TASK-060/062 are the intended callers).
 * - `condition` is evaluated synchronously against upstream outcomes
 *   (minimal DSL: `"<nodeId>.outcome == <outcome>"`).
 * - `shell` requires an injected executor (TASK-058 provides one).
 *
 * When every step of the pass is terminal the engine sets the run to
 * `waiting` and settles the `start()` promise — the caller owns the run's
 * final fate (advance the iteration, or close it out as completed/failed).
 */

export interface WorkflowExecutionContext {
  readonly workspaceId: string
  /**
   * Worktree isolation for agent steps. Present → agent steps launch as
   * `orchestrated`; absent → `attended` (ADR-0002: orchestrated without a
   * worktree must be refused, and AgentManager.start enforces that too).
   */
  readonly worktreeId?: string
  /**
   * Pre-allocated AgentRun id forwarded to AgentManager (TASK-059). Only
   * meaningful for a single-agent pass: Dispatch pre-allocates it so the
   * worktree branch and the prompt's handoff env paths can be bound before
   * launch. A multi-agent DAG must NOT set this — every node would share one
   * run id.
   */
  readonly agentRunId?: string
  /** Prompt forwarded to agent steps (TASK-059 renders it before start). */
  readonly prompt?: string
  /** Model override forwarded to agent steps (TASK-059). */
  readonly model?: string
  /** TASK-058: runtime + cwd that shell steps execute under. */
  readonly runtime?: WorkspaceRuntime
  readonly cwd?: string
}

export interface StepCompletion {
  /**
   * Effective outcome used for conditional-edge evaluation. `'failure'`
   * marks the step `failed`; any other outcome (or none) completes it.
   * Defaults to `'success'`.
   */
  readonly outcome?: string
  readonly result?: Record<string, unknown>
}

export interface WorkflowStepExecution {
  readonly run: WorkflowRun
  readonly step: WorkflowStep
  readonly node: WorkflowNode
  readonly context: WorkflowExecutionContext
  /** Effective outcomes of the node's upstream dependencies (nodeId → outcome). */
  readonly upstreamOutcomes: Readonly<Record<string, string>>
}

export interface WorkflowStepExecutor {
  /**
   * Starts the step. Event-driven: the returned promise settles the step;
   * the engine never polls. Settling after the step was cancelled is safe —
   * the late completion is ignored.
   */
  execute(execution: WorkflowStepExecution): Promise<StepCompletion>
  /** Best-effort cancellation hook invoked by WorkflowEngine.cancel. */
  cancel?(stepId: string): void | Promise<void>
}

export interface ResolveStepRequest {
  readonly outcome?: string
  readonly result?: Record<string, unknown>
}

export interface WorkflowEngine {
  /**
   * Executes one DAG pass for the run's current iteration. The returned
   * promise settles when the pass ends (all steps terminal) or the run is
   * cancelled; it never settles early while suspended steps await
   * `resolveStep`.
   */
  start(runId: string, context: WorkflowExecutionContext): Promise<IpcResult<WorkflowRunDetail>>
  /**
   * P0-4: starts a pass WITHOUT awaiting it — resolves as soon as the pass is
   * running (steps scheduled) with the current run snapshot. Pass progress
   * flows through `workflow.run_updated` / `workflow.step_updated` events; the
   * pass outcome is logged on failure. This is the entry point IPC handlers
   * must use: `start()` parks on suspended steps (checkpoint / criteria-gate /
   * review-panel), which would keep an ipcRenderer.invoke pending forever.
   */
  begin(runId: string, context: WorkflowExecutionContext): IpcResult<WorkflowRunDetail>
  /**
   * Resolves a suspended step (checkpoint / criteria-gate / review-panel).
   * `outcome` must be one of the node type's allowed outcomes; checkpoint
   * nodes take no outcome.
   */
  resolveStep(stepId: string, resolution?: ResolveStepRequest): IpcResult<WorkflowStep>
  /** Stops queued (pending) steps and cancels running ones via their executor. */
  cancel(runId: string): Promise<IpcResult<WorkflowRun>>
  /**
   * User-accepts a run parked at needs_user_review (iteration cap reached) and
   * closes it as 'completed' — the "accept & close the books" action after the
   * user reviewed/merged the outcome. Any other status is rejected: runs still
   * working get cancelled instead, and terminal runs have no exits.
   */
  complete(runId: string): Promise<IpcResult<WorkflowRun>>
  /**
   * Best-effort shutdown (TASK-059): cancels every active pass so executors
   * release their event subscriptions, and settles only once every cancel
   * has finished — the composition root awaits this so a cancel's trailing
   * writes never land on an already-closed database (P2-2).
   */
  dispose(): Promise<void>
}

export interface WorkflowEngineDeps {
  readonly runs: WorkflowRunStore
  readonly events: EventBus<WorkbenchEvents>
  /** Enables the default `agent` executor; without it agent nodes fail. */
  readonly agentManager?: Pick<AgentManager, 'start' | 'cancel'>
  /**
   * TASK-111 (§53.1/§54/§55): resolves the profile ALIASES on agent nodes
   * (`accountProfile` / `profile`) to machine-local Profile ids before launch,
   * and screens node `env` against the §13.2 reserved keys. Without it, a
   * node carrying aliases fails closed rather than guessing an identity.
   * P2-11: every agent node is prevalidated at pass start (begin/start), so
   * an unbound alias fails the run before any node produces side effects.
   */
  readonly profileAliases?: Pick<ProfileAliasManager, 'resolveAgentNodeProfiles'>
  /** Per-node-type executor overrides (tests, TASK-058 shell executor). */
  readonly executors?: Partial<Record<WorkflowNodeType, WorkflowStepExecutor>>
}

const TERMINAL_STEP_STATUSES: ReadonlySet<WorkflowStepStatus> = new Set([
  'completed',
  'failed',
  'skipped',
  'cancelled',
])

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

/** Node types that park in `running` until resolveStep (TASK-060/062). */
const SUSPENDED_NODE_TYPES: ReadonlySet<WorkflowNodeType> = new Set([
  'checkpoint',
  'criteria-gate',
  'review-panel',
])

/** Outcome a past-phase runOn-filtered node counts as (plan §153「出边照常激活」). */
const POSITIVE_OUTCOMES: Readonly<Record<WorkflowNodeType, string>> = {
  agent: 'success',
  shell: 'success',
  checkpoint: 'success',
  condition: 'true',
  'criteria-gate': 'pass',
  'review-panel': 'approve',
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function invalid<T>(message: string, detail: string): IpcResult<T> {
  return fail({ code: 'VALIDATION_FAILED', message, retryable: false, detail })
}

type ProfileAliasResolver = Pick<ProfileAliasManager, 'resolveAgentNodeProfiles'>

/**
 * TASK-111 (§53.1/§54): resolves one agent node's profile ALIASES
 * (`accountProfile` / `profile`) to machine-local Profile ids and screens its
 * `env` against the §13.2 reserved keys. Returns undefined when the node
 * declares neither aliases nor env. Every failure mode is fail-closed:
 * unbound alias, id-instead-of-alias (§55), deleted/disabled target, a
 * reserved env key, or a missing resolver all stop the launch instead of
 * silently falling back to another identity.
 */
function resolveAgentNodeProfiles(
  node: AgentWorkflowNode,
  profileAliases: ProfileAliasResolver | undefined,
): IpcResult<
  | {
      accountProfileId?: string | undefined
      executionProfileId?: string | undefined
      env?: Record<string, string> | undefined
    }
  | undefined
> {
  if (node.accountProfile === undefined && node.profile === undefined && node.env === undefined) {
    return { ok: true, data: undefined }
  }
  if (profileAliases === undefined) {
    return invalid(
      `Workflow node "${node.id}" declares profile aliases or env, ` +
        'but profile alias resolution is not available in this runtime.',
      `no profile alias resolver for workflow node ${JSON.stringify(node.id)}`,
    )
  }
  return profileAliases.resolveAgentNodeProfiles({
    agentId: node.agent,
    ...(node.accountProfile === undefined ? {} : { accountProfileAlias: node.accountProfile }),
    ...(node.profile === undefined ? {} : { executionProfileAlias: node.profile }),
    ...(node.env === undefined ? {} : { env: node.env }),
    source: `workflow node "${node.id}"`,
  })
}

/**
 * Code-review P2-11: resolves EVERY agent node's aliases / env before a pass
 * starts, so an unbound alias fails the run immediately instead of after
 * earlier DAG nodes already produced side effects. Nodes without aliases are
 * skipped; the failure modes match dispatch-time resolution exactly (the
 * agent executor re-resolves at dispatch, so a binding change between the
 * prevalidation and the launch still fails closed).
 */
export function prevalidateWorkflowAgentNodeProfiles(
  definition: WorkflowDefinition,
  profileAliases: ProfileAliasResolver | undefined,
): IpcResult<void> {
  for (const node of definition.steps) {
    if (node.type !== 'agent') continue
    const resolved = resolveAgentNodeProfiles(node, profileAliases)
    if (!resolved.ok) return resolved
  }
  return { ok: true, data: undefined }
}

interface NodeState {
  readonly node: WorkflowNode
  step: WorkflowStep
  terminal: boolean
  /** Effective outcome for conditional-edge evaluation; set once terminal. */
  outcome?: string | undefined
  /** Whether this node activates its UNCONDITIONAL out-edges. */
  activatesEdges: boolean
  cancel?: (() => void | Promise<void>) | undefined
}

interface PassState {
  readonly runId: string
  run: WorkflowRun
  readonly context: WorkflowExecutionContext
  readonly nodes: Map<string, NodeState>
  /** stepId → nodeId for steps parked awaiting resolveStep. */
  readonly suspended: Map<string, string>
  cancelling: boolean
  finish: (result: IpcResult<WorkflowRunDetail>) => void
}

function edgeActivated(dependency: NormalizedDependency, upstream: NodeState): boolean {
  if (!upstream.terminal) return false
  if (dependency.on !== undefined) {
    return upstream.outcome === dependency.on
  }
  return upstream.activatesEdges
}

/** Minimal condition DSL (TASK-057): `"<nodeId>.outcome == <outcome>"`. */
const CONDITION_PATTERN = /^([A-Za-z0-9_-]+)\.outcome\s*==\s*'?([A-Za-z0-9_-]+)'?$/u

function evaluateCondition(
  expression: string,
  upstreamOutcomes: Readonly<Record<string, string>>,
): StepCompletion {
  const match = CONDITION_PATTERN.exec(expression.trim())
  if (match === null) {
    return {
      outcome: 'failure',
      result: { error: `Unsupported condition expression: ${JSON.stringify(expression)}` },
    }
  }
  const nodeId = match[1] as string
  const expected = match[2] as string
  const actual = upstreamOutcomes[nodeId]
  return {
    outcome: actual === expected ? 'true' : 'false',
    result: { expression, nodeId, expected, actual },
  }
}

function createConditionStepExecutor(): WorkflowStepExecutor {
  return {
    execute({ node, upstreamOutcomes }) {
      return Promise.resolve(
        node.type === 'condition'
          ? evaluateCondition(node.expression, upstreamOutcomes)
          : {
              outcome: 'failure',
              result: { error: 'condition executor received a non-condition node' },
            },
      )
    },
  }
}

function createAgentStepExecutor(deps: {
  readonly agents: Pick<AgentManager, 'start' | 'cancel'>
  readonly events: EventBus<WorkbenchEvents>
  readonly profileAliases?: Pick<ProfileAliasManager, 'resolveAgentNodeProfiles'> | undefined
}): WorkflowStepExecutor {
  /** stepId → agentRunId, for cancel routing. */
  const agentRuns = new Map<string, string>()
  /** stepIds the engine cancelled while AgentManager.start was still in flight. */
  const cancelRequested = new Set<string>()
  /** stepId → in-flight execute(), so cancel can wait out a launch it interrupted. */
  const inFlight = new Map<string, Promise<StepCompletion>>()

  return {
    execute({ run, step, node, context }) {
      if (node.type !== 'agent') {
        return Promise.resolve({
          outcome: 'failure',
          result: { error: 'agent executor received a non-agent node' },
        })
      }
      // TASK-111 (§53.1/§54): the node names profile ALIASES, never ids —
      // resolve them against this machine's binding table before launch.
      // The engine's pass-start prevalidation (P2-11) already screened every
      // node; this re-resolution keeps the launch fail-closed if the binding
      // table changed in between.
      const profiles = resolveAgentNodeProfiles(node, deps.profileAliases)
      if (!profiles.ok) {
        return Promise.resolve({
          outcome: 'failure',
          result: { error: profiles.error.message, errorCode: profiles.error.code },
        })
      }
      const resolvedNodeProfiles = profiles.data
      const request: StartAgentRunRequest = {
        workspaceId: context.workspaceId,
        agentType: node.agent,
        // Workflow steps are unattended: the CLI must run headless and exit
        // when its turn ends. Interactive mode returns to the prompt instead
        // and the run (and with it the whole workflow) never completes.
        mode: 'exec',
        ...(context.agentRunId === undefined ? {} : { runId: context.agentRunId }),
        ...(node.role === undefined ? {} : { role: node.role }),
        ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
        executionMode: context.worktreeId === undefined ? 'attended' : 'orchestrated',
        ...(context.worktreeId === undefined ? {} : { worktreeId: context.worktreeId }),
        ...(context.prompt === undefined ? {} : { prompt: context.prompt }),
        ...(context.model === undefined ? {} : { model: context.model }),
        ...(resolvedNodeProfiles?.accountProfileId === undefined
          ? {}
          : { accountProfileId: resolvedNodeProfiles.accountProfileId }),
        ...(resolvedNodeProfiles?.executionProfileId === undefined
          ? {}
          : { executionProfileId: resolvedNodeProfiles.executionProfileId }),
        ...(resolvedNodeProfiles?.env === undefined
          ? {}
          : { environment: resolvedNodeProfiles.env }),
      }
      const executed = (async (): Promise<StepCompletion> => {
        const started = await deps.agents.start(request)
        if (!started.ok) {
          return { outcome: 'failure', result: { error: started.error.message } }
        }
        const agentRunId = started.data.id
        agentRuns.set(step.id, agentRunId)
        return new Promise<StepCompletion>((resolve) => {
          const unsubscribeAll = (): void => {
            for (const unsubscribe of unsubscribes) unsubscribe()
          }
          const done = (completion: StepCompletion): void => {
            unsubscribeAll()
            resolve(completion)
          }
          const unsubscribes = [
            deps.events.subscribe('agent.completed', (payload) => {
              if (payload.runId !== agentRunId) return
              done({
                outcome: payload.exitCode === 0 ? 'success' : 'failure',
                result: { agentRunId, exitCode: payload.exitCode },
              })
            }),
            deps.events.subscribe('agent.failed', (payload) => {
              if (payload.runId !== agentRunId) return
              done({ outcome: 'failure', result: { agentRunId, error: payload.error.message } })
            }),
            deps.events.subscribe('agent.cancelled', (payload) => {
              if (payload.runId !== agentRunId) return
              done({ outcome: 'failure', result: { agentRunId, cancelled: true } })
            }),
            deps.events.subscribe('agent.interrupted', (payload) => {
              if (payload.runId !== agentRunId) return
              done({ outcome: 'failure', result: { agentRunId, interrupted: payload.reason } })
            }),
          ]
          // The engine cancelled this step while the launch was in flight:
          // route the cancellation to the run that just materialized. The
          // subscriptions above are already in place, so the terminal event
          // the cancel provokes still settles this step.
          if (cancelRequested.delete(step.id)) {
            void deps.agents.cancel(agentRunId).then(
              () => undefined,
              () => undefined,
            )
          }
        })
      })()
      inFlight.set(step.id, executed)
      const cleanup = (): void => {
        inFlight.delete(step.id)
        agentRuns.delete(step.id)
        cancelRequested.delete(step.id)
      }
      void executed.then(cleanup, cleanup)
      return executed
    },

    async cancel(stepId) {
      cancelRequested.add(stepId)
      try {
        const agentRunId = agentRuns.get(stepId)
        if (agentRunId !== undefined) {
          await deps.agents.cancel(agentRunId).then(
            () => undefined,
            () => undefined,
          )
        }
        // A launch interrupted mid-flight must finish settling — with the
        // cancellation routed — before the engine tears the pass down.
        await inFlight.get(stepId)?.then(
          () => undefined,
          () => undefined,
        )
      } finally {
        cancelRequested.delete(stepId)
      }
    },
  }
}

export function createWorkflowEngine(deps: WorkflowEngineDeps): WorkflowEngine {
  const logger = getLogger('runtime')
  const conditionExecutor = createConditionStepExecutor()
  const agentExecutor =
    deps.agentManager === undefined
      ? undefined
      : createAgentStepExecutor({
          agents: deps.agentManager,
          events: deps.events,
          profileAliases: deps.profileAliases,
        })
  const passes = new Map<string, PassState>()
  /** stepId → runId for every suspended step, so resolveStep can route. */
  const suspendedSteps = new Map<string, string>()

  const emitStep = (step: WorkflowStep): void => {
    deps.events.emit('workflow.step_updated', {
      runId: step.workflowRunId,
      stepId: step.id,
      nodeId: step.nodeId,
      status: step.status,
    })
  }

  const resolveExecutor = (node: WorkflowNode): WorkflowStepExecutor | 'suspend' | undefined => {
    const custom = deps.executors?.[node.type]
    if (custom !== undefined) return custom
    if (SUSPENDED_NODE_TYPES.has(node.type)) return 'suspend'
    switch (node.type) {
      case 'agent':
        return agentExecutor
      case 'condition':
        return conditionExecutor
      default:
        return undefined
    }
  }

  const transition = (
    state: PassState,
    ns: NodeState,
    to: WorkflowStepStatus,
    result?: Record<string, unknown>,
  ): boolean => {
    const transitioned = deps.runs.transitionStep(
      ns.step.id,
      to,
      result === undefined ? {} : { result },
    )
    if (!transitioned.ok) {
      logger.error(
        { runId: state.runId, stepId: ns.step.id, to, error: transitioned.error },
        'Failed to transition a workflow step.',
      )
      return false
    }
    ns.step = transitioned.data
    emitStep(ns.step)
    return true
  }

  const settleNode = (state: PassState, ns: NodeState, completion: StepCompletion): void => {
    if (!passes.has(state.runId) || ns.terminal) return
    const outcome = completion.outcome ?? 'success'
    const failed = outcome === 'failure'
    ns.terminal = true
    ns.outcome = outcome
    ns.activatesEdges = !failed
    transition(state, ns, failed ? 'failed' : 'completed', { outcome, ...completion.result })
    schedule(state)
  }

  const startNode = (state: PassState, ns: NodeState): void => {
    if (!transition(state, ns, 'running')) {
      // Store rejected the transition; mark terminal so schedule() cannot spin.
      ns.terminal = true
      return
    }
    const executor = resolveExecutor(ns.node)
    if (executor === 'suspend') {
      state.suspended.set(ns.step.id, ns.node.id)
      suspendedSteps.set(ns.step.id, state.runId)
      return
    }
    if (executor === undefined) {
      settleNode(state, ns, {
        outcome: 'failure',
        result: { error: `No executor registered for workflow node type "${ns.node.type}".` },
      })
      return
    }
    if (executor.cancel !== undefined) {
      const cancel = executor.cancel.bind(executor)
      ns.cancel = () => cancel(ns.step.id)
    }
    const upstreamOutcomes: Record<string, string> = {}
    for (const dependency of normalizeDependsOn(ns.node.dependsOn)) {
      const upstream = state.nodes.get(dependency.node)
      if (upstream?.outcome !== undefined) {
        upstreamOutcomes[dependency.node] = upstream.outcome
      }
    }
    const execution: WorkflowStepExecution = {
      run: state.run,
      step: ns.step,
      node: ns.node,
      context: state.context,
      upstreamOutcomes,
    }
    try {
      executor.execute(execution).then(
        (completion) => settleNode(state, ns, completion),
        (cause: unknown) => {
          logger.error(
            { runId: state.runId, stepId: ns.step.id, nodeId: ns.node.id, cause },
            'Workflow step executor rejected.',
          )
          settleNode(state, ns, { outcome: 'failure', result: { error: 'Step executor failed.' } })
        },
      )
    } catch (cause) {
      logger.error(
        { runId: state.runId, stepId: ns.step.id, nodeId: ns.node.id, cause },
        'Workflow step executor threw.',
      )
      settleNode(state, ns, { outcome: 'failure', result: { error: 'Step executor failed.' } })
    }
  }

  /** Narrows getRun's nullable detail for the pass-end settlement. */
  const settleWithDetail = (
    state: PassState,
    result: IpcResult<WorkflowRunDetail | null>,
  ): void => {
    if (!result.ok) {
      state.finish({ ok: false, error: result.error })
      return
    }
    if (result.data === null) {
      state.finish(
        invalid(
          `Workflow run "${state.runId}" was not found.`,
          `run ${state.runId} vanished while its pass was settling`,
        ),
      )
      return
    }
    state.finish({ ok: true, data: result.data })
  }

  const finishPass = (state: PassState): void => {
    passes.delete(state.runId)
    for (const stepId of state.suspended.keys()) {
      suspendedSteps.delete(stepId)
    }
    const updated = deps.runs.setRunStatus(state.runId, 'waiting')
    if (!updated.ok) {
      state.finish({ ok: false, error: updated.error })
      return
    }
    state.run = updated.data
    deps.events.emit('workflow.run_updated', { runId: state.runId, status: 'waiting' })
    settleWithDetail(state, deps.runs.getRun(state.runId))
  }

  function schedule(state: PassState): void {
    if (state.cancelling) return
    let progressed = true
    while (progressed && !state.cancelling) {
      progressed = false
      for (const ns of state.nodes.values()) {
        if (ns.terminal || ns.step.status !== 'pending') continue
        const dependencies = normalizeDependsOn(ns.node.dependsOn)
        const upstreams = dependencies.map(
          (dependency) => state.nodes.get(dependency.node) as NodeState,
        )
        if (!upstreams.every((upstream) => upstream.terminal)) continue
        if (
          dependencies.every((dependency, index) =>
            edgeActivated(dependency, upstreams[index] as NodeState),
          )
        ) {
          startNode(state, ns)
        } else {
          ns.terminal = true
          ns.activatesEdges = false
          transition(state, ns, 'skipped', { reason: 'dependency-inactive' })
        }
        progressed = true
      }
    }
    if (!state.cancelling && [...state.nodes.values()].every((ns) => ns.terminal)) {
      finishPass(state)
    }
  }

  /**
   * Synchronous pass setup: validation, step creation, runOn filtering, and
   * the first schedule() run. On success the pass is registered and the
   * returned promise settles when it ends; callers choose to await it
   * (start) or not (begin).
   */
  const beginPass = (
    runId: string,
    context: WorkflowExecutionContext,
  ): IpcResult<Promise<IpcResult<WorkflowRunDetail>>> => {
    const found = deps.runs.getRun(runId)
    if (!found.ok) return found
    if (found.data === null) {
      return invalid(`Workflow run "${runId}" was not found.`, `engine start run=${runId}`)
    }
    const { run, steps } = found.data
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return invalid(
        `Workflow run "${runId}" is ${run.status}; no pass can start.`,
        `engine start on terminal run ${runId}`,
      )
    }
    if (passes.has(runId)) {
      return invalid(
        `Workflow run "${runId}" already has an active pass.`,
        `duplicate engine start for run ${runId}`,
      )
    }
    const iteration = run.currentIteration
    // The store counts iterations 0-based (a fresh run's first pass has
    // currentIteration 0 and steps are recorded with that number), while
    // activeNodeIdsForIteration is 1-based (plan §153). The first pass of
    // a run therefore executes at phase 1; TASK-062's IterationController
    // advances the counter between passes.
    const passPhase = iteration + 1
    const inFlight = steps.filter(
      (step) => step.iteration === iteration && step.status === 'running',
    )
    if (inFlight.length > 0) {
      return invalid(
        `Workflow run "${runId}" has in-flight steps from a previous pass; cancel it first.`,
        `run ${runId} iteration ${String(iteration)} running steps: ${inFlight.map((step) => step.id).join(', ')}`,
      )
    }

    // P2-11: every agent node's aliases must resolve BEFORE the pass creates
    // steps or schedules anything — an unbound alias fails the run here, not
    // after earlier DAG nodes already launched agents or ran shell commands.
    const prevalidated = prevalidateWorkflowAgentNodeProfiles(run.definition, deps.profileAliases)
    if (!prevalidated.ok) return prevalidated

    const state: PassState = {
      runId,
      run,
      context,
      nodes: new Map(),
      suspended: new Map(),
      cancelling: false,
      finish: () => undefined,
    }
    const promise = new Promise<IpcResult<WorkflowRunDetail>>((resolve) => {
      state.finish = resolve
    })

    const existing = new Map(
      steps.filter((step) => step.iteration === iteration).map((step) => [step.nodeId, step]),
    )
    for (const node of run.definition.steps) {
      let step = existing.get(node.id)
      if (step === undefined) {
        const added = deps.runs.addStep(runId, node.id)
        if (!added.ok) return added
        step = added.data
        emitStep(step)
      }
      state.nodes.set(node.id, {
        node,
        step,
        terminal: TERMINAL_STEP_STATUSES.has(step.status),
        activatesEdges: step.status === 'completed',
      })
    }
    passes.set(runId, state)

    // runOn filtering (plan §153「每轮的节点激活规则」): past-phase nodes
    // count as completed so their out-edges activate; future-phase nodes
    // activate nothing and propagate the skip.
    const active = activeNodeIdsForIteration(run.definition, passPhase)
    for (const ns of state.nodes.values()) {
      if (ns.terminal || active.has(ns.node.id)) continue
      const filteredPast = ns.node.runOn === 'first' && passPhase > 1
      ns.terminal = true
      ns.activatesEdges = filteredPast
      ns.outcome = filteredPast ? POSITIVE_OUTCOMES[ns.node.type] : undefined
      transition(state, ns, 'skipped', {
        reason: 'runOn-filtered',
        edgesActivated: filteredPast,
      })
    }

    if (run.status !== 'running') {
      const updated = deps.runs.setRunStatus(runId, 'running')
      if (!updated.ok) {
        passes.delete(runId)
        return updated
      }
      state.run = updated.data
      deps.events.emit('workflow.run_updated', { runId, status: 'running' })
    }

    schedule(state)
    return { ok: true, data: promise }
  }

  const engine: WorkflowEngine = {
    start(runId, context) {
      const begun = beginPass(runId, context)
      if (!begun.ok) return Promise.resolve({ ok: false, error: begun.error })
      return begun.data
    },

    begin(runId, context) {
      const begun = beginPass(runId, context)
      if (!begun.ok) return begun
      void begun.data.then(
        (result) => {
          if (!result.ok) {
            logger.error({ runId, error: result.error }, 'Workflow pass settled with an error.')
          }
        },
        (cause: unknown) => {
          logger.error({ runId, cause }, 'Workflow pass rejected.')
        },
      )
      const snapshot = deps.runs.getRun(runId)
      if (!snapshot.ok) return snapshot
      if (snapshot.data === null) {
        return invalid(
          `Workflow run "${runId}" was not found.`,
          `run ${runId} vanished right after its pass began`,
        )
      }
      return { ok: true, data: snapshot.data }
    },

    resolveStep(stepId, resolution = {}) {
      const runId = suspendedSteps.get(stepId)
      const state = runId === undefined ? undefined : passes.get(runId)
      if (runId === undefined || state === undefined) {
        return invalid(
          `Workflow step "${stepId}" is not awaiting a resolution.`,
          `resolveStep step=${stepId}: no suspended step with that id`,
        )
      }
      const nodeId = state.suspended.get(stepId) as string
      const ns = state.nodes.get(nodeId) as NodeState
      const allowed = WORKFLOW_CONDITION_OUTCOMES[ns.node.type]
      if (allowed.length === 0) {
        if (resolution.outcome !== undefined) {
          return invalid(
            `Workflow node "${nodeId}" (${ns.node.type}) has no outcomes.`,
            `resolveStep outcome=${resolution.outcome} on outcome-less node type ${ns.node.type}`,
          )
        }
      } else if (resolution.outcome === undefined || !allowed.includes(resolution.outcome)) {
        return invalid(
          `Workflow node "${nodeId}" (${ns.node.type}) requires outcome: ${allowed.join(' | ')}.`,
          `resolveStep outcome=${JSON.stringify(resolution.outcome)} not in [${allowed.join(', ')}]`,
        )
      }
      state.suspended.delete(stepId)
      suspendedSteps.delete(stepId)
      settleNode(state, ns, {
        outcome: resolution.outcome ?? 'success',
        ...(resolution.result === undefined ? {} : { result: resolution.result }),
      })
      return { ok: true, data: ns.step }
    },

    async cancel(runId) {
      const found = deps.runs.getRun(runId)
      if (!found.ok) return found
      if (found.data === null) {
        return invalid(`Workflow run "${runId}" was not found.`, `engine cancel run=${runId}`)
      }
      if (TERMINAL_RUN_STATUSES.has(found.data.run.status)) {
        return invalid(
          `Workflow run "${runId}" is already ${found.data.run.status}.`,
          `engine cancel on terminal run ${runId}`,
        )
      }
      const state = passes.get(runId)
      if (state === undefined) {
        const updated = deps.runs.setRunStatus(runId, 'cancelled')
        if (updated.ok) {
          deps.events.emit('workflow.run_updated', { runId, status: 'cancelled' })
        }
        return updated
      }
      state.cancelling = true
      for (const ns of state.nodes.values()) {
        if (ns.terminal) continue
        if (
          ns.step.status === 'running' &&
          !state.suspended.has(ns.step.id) &&
          ns.cancel !== undefined
        ) {
          await ns.cancel()
        }
        // The executor may have settled the step while we awaited its cancel.
        if (ns.terminal) continue
        ns.terminal = true
        ns.activatesEdges = false
        transition(state, ns, 'cancelled', { reason: 'run-cancelled' })
      }
      passes.delete(runId)
      for (const stepId of state.suspended.keys()) {
        suspendedSteps.delete(stepId)
      }
      const updated = deps.runs.setRunStatus(runId, 'cancelled')
      if (updated.ok) {
        deps.events.emit('workflow.run_updated', { runId, status: 'cancelled' })
      }
      settleWithDetail(state, deps.runs.getRun(runId))
      return updated
    },

    complete(runId) {
      const found = deps.runs.getRun(runId)
      if (!found.ok) return Promise.resolve(found)
      if (found.data === null) {
        return Promise.resolve(
          invalid(`Workflow run "${runId}" was not found.`, `engine complete run=${runId}`),
        )
      }
      if (found.data.run.status !== 'needs_user_review') {
        return Promise.resolve(
          invalid(
            `Workflow run "${runId}" is ${found.data.run.status}; only a run waiting for user review can be accepted.`,
            `engine complete on ${found.data.run.status} run ${runId}`,
          ),
        )
      }
      // A capped run never has an in-flight pass (the controller parked the
      // run); dropping any stale entry is defensive only.
      passes.delete(runId)
      const updated = deps.runs.setRunStatus(runId, 'completed')
      if (updated.ok) {
        deps.events.emit('workflow.run_updated', { runId, status: 'completed' })
      }
      return Promise.resolve(updated)
    },

    async dispose() {
      await Promise.allSettled([...passes.keys()].map((runId) => engine.cancel(runId)))
    },
  }

  return engine
}
