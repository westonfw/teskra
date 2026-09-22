import { randomUUID } from 'node:crypto'

import {
  approvalModeSchema,
  DEFAULT_CONFIG,
  isWorkspaceSecretRef,
  providerSessionRefSchema,
  type AgentContinuationReason,
  type AgentDefinition,
  type AgentFailureClassification,
  type AgentStartRequest,
  type AgentAccountProfile,
  type AgentExecutionProfile,
  type AgentResumeProfileContext,
  type AgentRun,
  type AgentRunProfileSnapshot,
  type AgentStructuredOutput,
  type ConcurrencyConfig,
  type ContinueAgentRunRequest,
  type DecisionOption,
  type IpcResult,
  type ListAgentRunsRequest,
  type ObservabilityConfig,
  type ProviderSessionRef,
  type PublicAppError,
  type QueuedReason,
  type ResizeAgentRunRequest,
  type ResumeAgentRunRequest,
  type RetryConfig,
  type SendAgentRunInputRequest,
  type StartAgentRunRequest,
  type TaskStatus,
  type WorkbenchEvents,
  type Workspace,
  type WorkspaceRuntimeRef,
} from '@teskra/contracts'

import type { AgentEventRepository } from '../db/repositories/agent-event-repository'
import type {
  AccountEventRepository,
  AppendAccountEventInput,
} from '../db/repositories/account-event-repository'
import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { ArtifactRepository } from '../db/repositories/artifact-repository'
import type { CriteriaRepository } from '../db/repositories/criteria-repository'
import type { HandoffRepository } from '../db/repositories/handoff-repository'
import type { TaskRepository } from '../db/repositories/task-repository'
import type { WorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { WorktreeRepository } from '../db/repositories/worktree-repository'
import type { DecisionService } from '../decisions/decision-service'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { TeskraPaths } from '../paths'
import type { HostProcessControl } from '../process/host-processes'
import type { ProcessManager } from '../process/process-manager'
import { terminateSurvivorProcess } from '../process/survivor'
import { buildHandoffContext } from '@teskra/shared'
import { resolveEnvReferences, type CredentialStore } from '../security/credential-store'
import type { AgentRegistry } from './agent-registry'
import { createAgentOutputBatcher } from './agent-output-batcher'
import { createHandoffCollector, type HandoffCollector } from './handoff-collector'
import { buildAgentContinuation, buildContinuationPrompt } from './continuation-builder'
import type { AgentPermissionPreparer } from '../permissions/permission-manager'
import {
  prepareAgentPermission,
  permissionProfileForApprovalMode,
} from './permissions/permission-projection'
import type { ReviewCollector } from './review-collector'
import type { RunLogStore } from './run-log-store'
import type { CodingAgentAdapter } from './adapters/coding-agent-adapter'
import type { AgentFailureClassifier } from './adapters/failure-classifier'
import type { AccountProfileManager } from './accounts/account-profile-manager'
import { assertNoReservedEnvKeys } from './accounts/reserved-env-keys'
import {
  isHistoricalRuntimeCompatible,
  projectHistoricalProfileIdentity,
} from './accounts/runtime-identity'
import type { ExecutionProfileManager } from './execution-profiles/execution-profile-manager'
import type { ObservationRecorder } from './observation/observation-recorder'
import type { WorkspaceRuntime } from '../workspace/runtime'

/**
 * TASK-139 (Milestone 26 §9): Main-internal start extension — a native
 * provider session the NEW run resumes (the user-message continuation). It
 * never crosses IPC: `startAgentRunRequestSchema` is a strictObject, so the
 * router rejects these keys from a renderer; only in-process callers
 * (continueWithProfile) can set them.
 */
export interface InternalStartAgentRunRequest extends StartAgentRunRequest {
  readonly resumeSession?: ProviderSessionRef
  readonly resumeProfileContext?: AgentResumeProfileContext
}

export interface AgentManager {
  start(request: InternalStartAgentRunRequest): Promise<IpcResult<AgentRun>>
  resume(request: ResumeAgentRunRequest): Promise<IpcResult<AgentRun>>
  send(request: SendAgentRunInputRequest): Promise<IpcResult<void>>
  resize(request: ResizeAgentRunRequest): IpcResult<void>
  cancel(runId: string): Promise<IpcResult<AgentRun>>
  get(runId: string): IpcResult<AgentRun | null>
  list(request?: ListAgentRunsRequest): IpcResult<AgentRun[]>
  /**
   * The run's full terminal output, or only its last `tailBytes` bytes when
   * the option is set (P1-6 — long runs no longer require a full read).
   */
  getOutput(runId: string, options?: { tailBytes?: number }): IpcResult<string>
  /**
   * TASK-107 (§19.3/§19.4/§19.5): the single transition entry for flow B —
   * registers "terminal intent: failed + this classification" BEFORE stopping
   * the process, so the process.exited branch never rewrites it as a plain
   * cancel. Idempotent: an already failed+classified run returns success
   * without touching the process; other terminal states are an error (the
   * caller must use flow A). A stop timeout or an unkillable survivor aborts
   * with an error and leaves the run untouched.
   */
  failAndStop(
    runId: string,
    classification: AgentFailureClassification,
  ): Promise<IpcResult<AgentRun>>
  /**
   * TASK-107 (§19.2/§19.3): cross-profile continuation. Terminal source run →
   * flow A (no state change on the source); live source run → flow B
   * (failAndStop first). The target run is a NEW run on the same task and the
   * same worktree under the requested account identity, prompted with the
   * continuation context (§20).
   */
  continueWithProfile(request: ContinueAgentRunRequest): Promise<IpcResult<AgentRun>>
  /** Stops every active run (P0-2 shutdown), then detaches from the EventBus. */
  dispose(): Promise<void>
}

export interface AgentManagerDeps {
  readonly registry: AgentRegistry
  readonly adapters: readonly CodingAgentAdapter[]
  readonly runs: AgentRunRepository
  readonly agentEvents: AgentEventRepository
  /**
   * TASK-116 (§41): audit sink for the Run-related account events
   * (agent.profile_selected / agent.rate_limited; TASK-107 adds
   * agent.continuation_created / agent.account_switched). Appends are
   * best-effort: failures are logged, never fatal to the Run lifecycle.
   */
  readonly accountEvents?: Pick<AccountEventRepository, 'append'>
  readonly handoffs: HandoffRepository
  readonly workspaces: WorkspaceRepository
  readonly tasks: TaskRepository
  readonly worktrees: WorktreeRepository
  readonly events: EventBus<WorkbenchEvents>
  readonly paths: TeskraPaths
  readonly runLogs: RunLogStore
  readonly handoffCollector?: HandoffCollector
  /** TASK-053: persists review findings from collected handoffs (ADR-0004). */
  readonly reviewCollector?: ReviewCollector
  readonly createRunId?: () => string
  readonly now?: () => string
  readonly resolveConcurrency?: (workspaceId: string) => IpcResult<ConcurrencyConfig>
  /**
   * TASK-122 (Milestone 25 §6.1): resolves the observability config group for
   * the structured-output gate. Without it, DEFAULT_CONFIG.observability
   * (structuredStream on) applies.
   */
  readonly resolveObservability?: (workspaceId: string) => IpcResult<ObservabilityConfig>
  /**
   * TASK-121 (Milestone 25 §5.4): resolves the retry config group for the
   * transient-failure auto-retry. Without it, DEFAULT_CONFIG.retry
   * (transientAttempts 1) applies.
   */
  readonly resolveRetry?: (workspaceId: string) => IpcResult<RetryConfig>
  /**
   * TASK-121 (§5.4): workflow membership probe — a run referenced by a
   * workflow step's result is never auto-retried (the Iterate primitive owns
   * Workflow retries). Without it, only the run row's own workflow link
   * columns gate the retry.
   */
  readonly workflows?: Pick<WorkflowRunRepository, 'hasStepWithAgentRun'>
  /**
   * TASK-065: when injected, the PermissionManager resolves the layered rules
   * into the Run's profile before projection. Without it, the profile is the
   * bare approval-mode default (TASK-077 behavior).
   */
  readonly permissions?: AgentPermissionPreparer
  /**
   * TASK-088: workspace env secret refs (`{ secretRef }`) are resolved to
   * plaintext through the Credential Store at launch time. The plaintext is
   * only ever handed to the process environment — never persisted, logged,
   * or written to the Run directory. A Run whose secret cannot be resolved
   * fails explicitly instead of launching without it.
   */
  readonly credentials?: CredentialStore
  /**
   * Captures the process-start identity token when a run's host pid is recorded
   * (migration 011 `pid_identity`), so reconciliation can tell "the Agent
   * process survived" apart from "the pid was reused by an unrelated process"
   * before terminating anything. Without it, runs fall back to probe-only
   * survivor handling. `terminate` is used by cancel() for a best-effort,
   * identity-verified stop of a previous-instance process before the run is
   * settled to its terminal state.
   */
  readonly hostProcesses?: Pick<HostProcessControl, 'probe' | 'identity' | 'terminate'>
  /**
   * TASK-107 (§19.3 flow B): failAndStop stops the source process through
   * the PTY authority's interrupt → terminate → kill ladder. Without it,
   * failAndStop on a run with a live process is rejected rather than
   * falling back to a blind pid kill.
   */
  readonly processes?: Pick<ProcessManager, 'stop'>
  /** TASK-107 (§20): artifact ids folded into the continuation context. */
  readonly artifacts?: Pick<ArtifactRepository, 'listByRun'>
  /** TASK-107 (§20): acceptance criteria folded into the continuation context. */
  readonly criteria?: Pick<CriteriaRepository, 'getSetById' | 'listCriteria'>
  /**
   * Milestone 24 (TASK-100): account-profile resolution for the Run lifecycle.
   * start() runs the §37 selector (explicit → default → legacy), resume()
   * restores the historical identity from the run row (§38). Without it, any
   * explicit accountProfileId is rejected rather than silently ignored.
   */
  readonly accountProfiles?: Pick<
    AccountProfileManager,
    'resolve' | 'get' | 'adapterFor' | 'reservedEnvKeys'
  >
  /**
   * Milestone 24 (TASK-110, §14): execution-profile resolution for Run
   * start. The profile supplies account (when the request does not pin one
   * explicitly), model, reasoningEffort, and approvalMode; its agentId must
   * equal the request's agentType. Without it, any explicit
   * executionProfileId is rejected rather than silently ignored.
   */
  readonly executionProfiles?: Pick<ExecutionProfileManager, 'resolve'>
  /**
   * TASK-105 (§17 / ADR-0010): per-agent failure classifiers. Runs of an
   * agent without a registered classifier keep a NULL
   * failure_classification_json — classification is best-effort metadata,
   * never a lifecycle gate.
   */
  readonly failureClassifiers?: readonly AgentFailureClassifier[]
  /**
   * TASK-123 (§6.2 / ADR-0013): the structured-output observation recorder.
   * The AgentManager attaches a parser when the launch request carries a
   * resolved non-`none` `structuredOutput` (TASK-122) and feeds every raw
   * `process.output` chunk to it BEFORE the 32ms output batcher; on process
   * exit the recorder's latest `error` observation joins the classifier
   * context as structuredEvents (ADR-0010 §4). Observation-only — it never
   * changes Run state.
   */
  readonly observations?: Pick<
    ObservationRecorder,
    'attach' | 'ingestChunk' | 'flush' | 'structuredErrorFor'
  >
  /** Resolves the workspace runtime object for profile env projection (§13). */
  readonly resolveRuntime?: (ref: WorkspaceRuntimeRef) => IpcResult<WorkspaceRuntime>
  /**
   * TASK-130 (ADR-0014 §3, design §9.2): with a DecisionService composed, a
   * run whose terminal classification is `rate-limited` (settleFailedStop /
   * stopExited) additionally opens a persisted `rate_limit` PendingDecision
   * with the TASK-108 Alert's option vocabulary (the Alert stays), every
   * terminal settle cancels the run's open decisions (stalled_run /
   * agent_blocker), and the rate_limit resolution actions are subscribed here.
   */
  readonly decisions?: Pick<DecisionService, 'open' | 'onResolved' | 'cancelBySource'>
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

/**
 * §9.2: the TASK-108 Alert action vocabulary, persisted as decision options.
 * continue_with_account has no Main-side action — picking the target account is
 * the renderer's ContinueWithAccountModal flow; wait is the §9.1 timeout
 * default.
 */
const RATE_LIMIT_OPTIONS: readonly DecisionOption[] = [
  { id: 'continue_with_account', label: 'Continue with another account' },
  { id: 'retry', label: 'Retry' },
  { id: 'wait', label: 'Wait' },
]

const MISSING_MESSAGE_KEYS = {
  'Agent run': 'errorMessage.agentRunNotFound',
  workspace: 'errorMessage.workspaceNotFound',
  task: 'errorMessage.taskNotFound',
  worktree: 'errorMessage.worktreeNotFound',
} as const

function missing(kind: keyof typeof MISSING_MESSAGE_KEYS, id: string): IpcResult<never> {
  return fail({
    code: kind === 'workspace' ? 'WORKSPACE_NOT_FOUND' : 'VALIDATION_FAILED',
    message: `${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)} "${id}" was not found.`,
    messageKey: MISSING_MESSAGE_KEYS[kind],
    params: { id },
    retryable: false,
    detail: `AgentManager could not resolve ${kind} id=${JSON.stringify(id)}`,
  })
}

function isTerminal(run: AgentRun): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
}

/** §41: the continuation reason read off the source run's terminal truth. */
function deriveContinuationReason(run: AgentRun): AgentContinuationReason {
  return run.failureClassification?.kind === 'rate-limited'
    ? 'rate-limit'
    : run.status === 'failed'
      ? 'agent-failure'
      : 'manual-switch'
}

/** TASK-107 (§19.3): the error recorded on a fail-and-stopped run. */
function failStopError(classification: AgentFailureClassification): PublicAppError {
  return {
    code: 'UNKNOWN',
    message: `The Agent run was stopped to continue with another account (${classification.kind}).`,
    retryable: true,
  }
}

function runningForLimits(runs: readonly AgentRun[]): AgentRun[] {
  return runs.filter((run) => run.status !== 'queued')
}

/**
 * TASK-120 (§5.5): the reason a run ENTERS the queue — behind already queued
 * runs (`fifo`, checked first: a nonempty queue serializes regardless of
 * capacity) or out of concurrency capacity (`capacity`).
 */
function queueEntryReason(
  runs: readonly AgentRun[],
  capacityAvailable: boolean,
): QueuedReason | undefined {
  if (runs.some((run) => run.status === 'queued')) return 'fifo'
  return capacityAvailable ? undefined : 'capacity'
}

function unisolatedWriteConflict(
  runs: readonly AgentRun[],
  workspaceId: string,
  worktreeId: string | undefined,
  approvalMode: AgentRun['approvalMode'],
): AgentRun | undefined {
  if (worktreeId !== undefined || approvalMode === 'read-only') return undefined
  return runs.find(
    (run) =>
      run.workspaceId === workspaceId &&
      run.worktreeId === undefined &&
      run.approvalMode !== 'read-only',
  )
}

/**
 * TASK-107 (§19.3 step 3) — the worktree reservation invariant
 * `unisolatedWriteConflict()` cannot express: one worktree hosts at most ONE
 * non-terminal run. It is what makes continuation flow A/B safe — after the
 * source run is confirmed terminal, no other live run may be writing the
 * worktree the target run is about to reuse. `runs` is the non-terminal set
 * (listActive), so a terminal source run never conflicts with its own
 * continuation.
 */
function worktreeRunConflict(
  runs: readonly AgentRun[],
  worktreeId: string | undefined,
  excludeRunId?: string,
): AgentRun | undefined {
  if (worktreeId === undefined) return undefined
  return runs.find((run) => run.worktreeId === worktreeId && run.id !== excludeRunId)
}

/**
 * TASK-117 (§46.3): `profileMaxConcurrentRuns` is the candidate profile's own
 * limit. `undefined` means "no per-profile limit" — either the candidate is a
 * legacy run without a profile (§46.1: only `maxRunsPerAgent` applies) or the
 * profile row is gone / sets no limit.
 */
function hasCapacity(
  runs: readonly AgentRun[],
  candidate: { workspaceId: string; agentType: string; accountProfileId?: string | undefined },
  policy: ConcurrencyConfig,
  profileMaxConcurrentRuns?: number,
): boolean {
  const perProfileOk =
    candidate.accountProfileId === undefined ||
    profileMaxConcurrentRuns === undefined ||
    runs.filter((run) => run.accountProfileId === candidate.accountProfileId).length <
      profileMaxConcurrentRuns
  return (
    perProfileOk &&
    runs.length < policy.maxGlobalRuns &&
    runs.filter((run) => run.workspaceId === candidate.workspaceId).length <
      policy.maxRunsPerWorkspace &&
    runs.filter((run) => run.agentType === candidate.agentType).length < policy.maxRunsPerAgent
  )
}

interface PendingRun {
  readonly adapter: CodingAgentAdapter
  readonly request: AgentStartRequest
  readonly resumed: boolean
  readonly resumeSession?: ProviderSessionRef
  /** §10.5: historical profile identity attached to a native session resume. */
  readonly resumeProfileContext?: AgentResumeProfileContext
}

const RESUME_OUTPUT_CONTEXT_CHARS = 6_000

/** §17.3: only a bounded tail of the terminal log feeds the classifier. */
const CLASSIFICATION_TAIL_BYTES = 16 * 1024

export function buildResumeContext(
  run: Pick<AgentRun, 'id' | 'prompt'>,
  recentOutput: string,
  handoffSummary?: string,
  additionalPrompt?: string,
): string {
  const output = recentOutput.slice(-RESUME_OUTPUT_CONTEXT_CHARS).trim()
  return [
    `Resume interrupted Teskra Run ${run.id} from the existing workspace state.`,
    run.prompt === undefined ? undefined : `Original request:\n${run.prompt}`,
    handoffSummary === undefined ? undefined : `Handoff summary:\n${handoffSummary}`,
    output.length === 0 ? undefined : `Recent Agent output:\n${output}`,
    additionalPrompt === undefined ? undefined : `Additional instructions:\n${additionalPrompt}`,
    'Inspect the current files before changing them and continue the unfinished work.',
  ]
    .filter((part): part is string => part !== undefined)
    .join('\n\n')
}

/** TASK-028: owns AgentRun lifecycle, provider routing, process events, and persistence. */
export function createAgentManager(deps: AgentManagerDeps): AgentManager {
  const logger = getLogger('agent')
  const adapters = new Map(deps.adapters.map((adapter) => [adapter.definition.id, adapter]))
  const failureClassifiers = new Map(
    (deps.failureClassifiers ?? []).map((classifier) => [classifier.agentId, classifier]),
  )
  const activeAdapters = new Map<string, CodingAgentAdapter>()
  const pendingRuns = new Map<string, PendingRun>()
  const cancelRequested = new Set<string>()
  /**
   * TASK-107 (§19.3): run ids whose terminal intent is `failed` + this
   * classification, registered BEFORE the process is stopped so the
   * process.exited branch never rewrites the run as a plain cancel.
   */
  const failStopIntents = new Map<string, AgentFailureClassification>()
  /**
   * In-flight adapterless cancels, claimed BEFORE the first await: a second
   * cancel() of the same run awaits the same execution instead of running
   * its own identity read and terminate against the same pid.
   */
  const adapterlessCancels = new Map<string, Promise<IpcResult<AgentRun>>>()
  /**
   * P0-3 (docs/code-review-2026-09-21.md §2): run ids whose launch() is
   * in-flight in THIS instance (the `preparing` window before processId/pid
   * are recorded). failAndStop refuses such runs with a retryable CONFLICT
   * instead of settling the row underneath the in-flight launch — which used
   * to leak the just-started process and let the continuation's target run
   * write the same worktree concurrently.
   */
  const inFlightLaunches = new Set<string>()
  /**
   * P1-1 (docs/code-review-2026-09-21.md §3): in-flight fail-and-stops,
   * claimed BEFORE the first await — a concurrent failAndStop of the same run
   * awaits the same execution instead of writing failed + agent.failed twice
   * (same shape as adapterlessCancels).
   */
  const failStopInFlights = new Map<string, Promise<IpcResult<AgentRun>>>()
  const createRunId = deps.createRunId ?? randomUUID
  const now = deps.now ?? (() => new Date().toISOString())
  const resolveConcurrency =
    deps.resolveConcurrency ?? (() => ({ ok: true, data: DEFAULT_CONFIG.concurrency }))
  const resolveObservability =
    deps.resolveObservability ?? (() => ({ ok: true, data: DEFAULT_CONFIG.observability }))
  const resolveRetry = deps.resolveRetry ?? (() => ({ ok: true, data: DEFAULT_CONFIG.retry }))

  /**
   * TASK-122 (§6.1): resolves the structured-output protocol for one launch.
   * Only exec-mode runs of an agent whose definition declares a non-`none`
   * family qualify, and only while `observability.structuredStream` is on.
   * A config read failure is non-fatal for observability — warn and apply the
   * built-in default (the concurrency resolution above already fails loudly
   * on the same config source).
   */
  const resolveStructuredOutput = (
    definition: AgentDefinition,
    mode: 'interactive' | 'exec',
    workspaceId: string,
  ): AgentStructuredOutput | undefined => {
    if (
      mode !== 'exec' ||
      definition.output === undefined ||
      definition.output.structured === 'none'
    ) {
      return undefined
    }
    const observability = resolveObservability(workspaceId)
    if (!observability.ok) {
      logger.warn(
        { workspaceId, agentType: definition.id, error: observability.error },
        'Failed to resolve the observability config; applying the built-in default.',
      )
    }
    const structuredStream = (observability.ok ? observability.data : DEFAULT_CONFIG.observability)
      .structuredStream
    return structuredStream ? definition.output : undefined
  }
  const handoffCollector =
    deps.handoffCollector ??
    createHandoffCollector({ handoffs: deps.handoffs, paths: deps.paths, now })
  let advancingQueue = false
  let advanceAgain = false

  /**
   * TASK-088: returns the workspace with env secret refs replaced by their
   * resolved plaintext for process launch. Workspaces without refs pass
   * through untouched.
   */
  const resolveLaunchWorkspace = (workspace: Workspace): IpcResult<Workspace> => {
    if (workspace.env === undefined || !Object.values(workspace.env).some(isWorkspaceSecretRef)) {
      return { ok: true, data: workspace }
    }
    const env = resolveEnvReferences(workspace.env, deps.credentials)
    return env.ok ? { ok: true, data: { ...workspace, env: env.data } } : env
  }

  const appendEvent = (
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): void => {
    const timestamp = now()
    const durable = deps.runLogs.appendEvent(runId, eventType, payload, timestamp)
    if (!durable.ok) {
      logger.error({ runId, eventType, error: durable.error }, 'Failed to persist durable event.')
      return
    }
    const appended = deps.agentEvents.append(
      {
        runId,
        seq: durable.data.seq,
        eventType,
        payload: durable.data.payload,
      },
      timestamp,
    )
    if (!appended.ok) {
      logger.error({ runId, eventType, error: appended.error }, 'Failed to persist Agent event.')
    }
  }

  /**
   * TASK-116 (§41): account audit events live ONLY in `account_events` (they
   * are not Run-log events); appends are best-effort like appendEvent.
   */
  const appendAccountEvent = (input: AppendAccountEventInput): void => {
    if (deps.accountEvents === undefined) {
      return
    }
    const appended = deps.accountEvents.append(input, now())
    if (!appended.ok) {
      logger.error(
        { eventType: input.eventType, runId: input.runId, error: appended.error },
        'Failed to persist the account audit event.',
      )
    }
  }

  const persistRunManifest = (run: AgentRun): void => {
    const written = deps.runLogs.writeRun(run)
    if (!written.ok) {
      logger.error({ runId: run.id, error: written.error }, 'Failed to update Run manifest.')
    }
  }

  /**
   * TASK-120 (§5.5): advanceQueue re-evaluates skip reasons on every pass, so
   * the row is only rewritten when the reason actually changed — a no-op pass
   * must never touch the database.
   */
  const updateQueuedReason = (run: AgentRun, reason: QueuedReason): void => {
    if (run.queuedReason === reason) return
    const updated = deps.runs.update(run.id, { queuedReason: reason }, now())
    if (!updated.ok) {
      logger.error(
        { runId: run.id, reason, error: updated.error },
        'Failed to update the Agent queue reason.',
      )
    }
  }

  /**
   * P1-1: durability checkpoint for terminal lifecycle transitions — forces an
   * fsync of the run's throttle-deferred log writes (so a crash can never lose
   * a terminal status the DB already recorded) and releases the file handles
   * so RetentionService (TASK-069) can collect the logs of finished runs.
   */
  const closeRunLogs = (runId: string): void => {
    const closed = deps.runLogs.dispose(runId)
    if (!closed.ok) {
      logger.error({ runId, error: closed.error }, 'Failed to flush and close Run logs.')
    }
  }

  /**
   * ADR-0004: handoff collection is best-effort — a collector failure is
   * logged and the Run keeps its terminal status either way.
   */
  const collectHandoff = (runId: string): void => {
    try {
      const collected = handoffCollector.collect(runId)
      if (!collected.ok) {
        logger.error(
          { runId, error: collected.error },
          'Handoff collection failed; the Run result is unaffected.',
        )
        return
      }
      // TASK-053: findings ride along with collection; ingest is best-effort
      // and never blocks Run completion either.
      if (collected.data !== null) deps.reviewCollector?.ingest(runId, collected.data)
    } catch (cause) {
      logger.error({ runId, cause }, 'Handoff collection threw; the Run result is unaffected.')
    }
  }

  const outputBatcher = createAgentOutputBatcher((runId, data) => {
    const terminal = deps.runLogs.appendTerminal(runId, data)
    if (!terminal.ok) {
      logger.error({ runId, error: terminal.error }, 'Failed to append durable terminal output.')
    }
    appendEvent(runId, 'agent.output', { data })
    const timestamp = now()
    const updated = deps.runs.update(runId, { lastOutputAt: timestamp }, timestamp)
    if (!updated.ok) {
      logger.error({ runId, error: updated.error }, 'Failed to update Agent output time.')
    }
    // P1-1: the manifest is deliberately NOT rewritten per output batch —
    // run.json follows lifecycle transitions only, so its lastOutputAt may lag
    // behind SQLite (the authoritative read path) until the next transition.
    deps.events.emit('agent.output', { runId, data })
  })

  const synchronizeTaskStatus = (run: AgentRun): void => {
    if (run.taskId === undefined) return
    const taskRuns = deps.runs.listByTask(run.taskId)
    if (!taskRuns.ok) {
      logger.error({ taskId: run.taskId, error: taskRuns.error }, 'Failed to read Task runs.')
      return
    }
    const hasActiveRun = taskRuns.data.some((candidate) => !isTerminal(candidate))
    const terminalStatus: Partial<Record<AgentRun['status'], TaskStatus>> = {
      completed: 'needs_review',
      failed: 'failed',
      cancelled: 'cancelled',
      interrupted: 'blocked',
    }
    const status = hasActiveRun ? 'running' : terminalStatus[run.status]
    if (status === undefined) return
    const task = deps.tasks.getById(run.taskId)
    if (!task.ok || task.data === null) {
      logger.error(
        { taskId: run.taskId, error: task.ok ? undefined : task.error },
        'Failed to resolve Task for Agent lifecycle update.',
      )
      return
    }
    if (task.data.status === status) return
    const updated = deps.tasks.updateStatus(run.taskId, status, now())
    if (!updated.ok) {
      logger.error({ taskId: run.taskId, error: updated.error }, 'Failed to update Task status.')
      return
    }
    deps.events.emit('task.updated', { taskId: run.taskId })
  }

  /**
   * TASK-105 (§17.0 (a) / §17.2): failure classification is post-hoc — it
   * runs only once the Run is already on its way to `failed` (the process
   * exited non-zero, or the launch itself failed). Nothing here ever kills a
   * process or changes a Run/Profile state based on live-stream text.
   */
  const failureClassifierFor = (runId: string): AgentFailureClassifier | undefined => {
    if (failureClassifiers.size === 0) return undefined
    const run = deps.runs.getById(runId)
    if (!run.ok) {
      logger.warn(
        { runId, error: run.error },
        'Failed to read the Agent run for failure classification.',
      )
      return undefined
    }
    if (run.data === null) return undefined
    return failureClassifiers.get(run.data.agentType)
  }

  const readClassificationTail = (runId: string): string => {
    const tail = deps.runLogs.readTerminalTail(runId, CLASSIFICATION_TAIL_BYTES)
    if (!tail.ok) {
      logger.warn(
        { runId, error: tail.error },
        'Failed to read the output tail for failure classification.',
      )
      return ''
    }
    return tail.data ?? ''
  }

  /**
   * TASK-123 / ADR-0010 §4: the run's latest structured `error` observation
   * (redacted, observation-only while the run lived) joins the classifier
   * context as structuredEvents — read ONLY on the post-exit / settle paths.
   */
  const structuredErrorEvents = (runId: string): { structuredEvents?: readonly unknown[] } => {
    const error = deps.observations?.structuredErrorFor(runId)
    return error === undefined ? {} : { structuredEvents: [error] }
  }

  /** TASK-116 (§41): a run whose terminal classification is a rate limit. */
  const auditRateLimited = (run: AgentRun): void => {
    const classification = run.failureClassification
    if (classification?.kind !== 'rate-limited') {
      return
    }
    appendAccountEvent({
      ...(run.accountProfileId === undefined ? {} : { profileId: run.accountProfileId }),
      runId: run.id,
      eventType: 'agent.rate_limited',
      payload: {
        agentType: run.agentType,
        ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
        ...(run.accountProfileId === undefined ? {} : { accountProfileId: run.accountProfileId }),
        retryable: classification.retryable,
        ...(classification.resetAt === undefined ? {} : { resetAt: classification.resetAt }),
      },
    })
  }

  /**
   * TASK-130 (ADR-0014 §3): a run reaching its terminal state cancels every
   * decision its live phase opened (stalled_run / agent_blocker). Best-effort;
   * the caller continues either way.
   */
  const cancelRunDecisions = (runId: string): void => {
    if (deps.decisions === undefined) return
    const cancelled = deps.decisions.cancelBySource({ runId })
    if (!cancelled.ok) {
      logger.error({ runId, error: cancelled.error }, "Failed to cancel the run's open decisions.")
    }
  }

  /**
   * TASK-130 (§9.2): the persisted sibling of the TASK-108 RateLimitAlert —
   * same option vocabulary, the Alert stays. Opens once per run (dedupeKey).
   */
  const openRateLimitDecision = (run: AgentRun): void => {
    const classification = run.failureClassification
    if (deps.decisions === undefined || classification?.kind !== 'rate-limited') return
    const opened = deps.decisions.open({
      workspaceId: run.workspaceId,
      kind: 'rate_limit',
      severity: 'warning',
      dedupeKey: `rate_limit:${run.id}`,
      title: 'The Agent account hit a rate limit',
      detail: {
        kind: 'rate_limit',
        message: classification.evidence ?? 'The Agent account hit a rate limit.',
        ...(classification.resetAt === undefined ? {} : { limitedUntil: classification.resetAt }),
        ...(run.accountProfileId === undefined ? {} : { accountProfileId: run.accountProfileId }),
      },
      options: RATE_LIMIT_OPTIONS,
      runId: run.id,
    })
    if (!opened.ok) {
      logger.error(
        { runId: run.id, error: opened.error },
        'Failed to open the rate-limit decision.',
      )
    }
  }

  const finishFailed = (runId: string, error: PublicAppError): IpcResult<AgentRun> => {
    const finishedAt = now()
    // TASK-105: a launch-time failure has no exit code; the adapter error
    // plus whatever output exists still feeds the classifier (§17.2).
    deps.observations?.flush(runId)
    const classifier = failureClassifierFor(runId)
    const failureClassification = classifier?.classify({
      outputTail: [readClassificationTail(runId), error.message]
        .filter((part) => part.length > 0)
        .join('\n'),
      ...structuredErrorEvents(runId),
    })
    appendEvent(runId, 'agent.failed', { error })
    const updated = deps.runs.update(
      runId,
      {
        status: 'failed',
        finishedAt,
        error: { ...error },
        ...(failureClassification === undefined ? {} : { failureClassification }),
      },
      finishedAt,
    )
    activeAdapters.delete(runId)
    if (updated.ok && updated.data !== null) persistRunManifest(updated.data)
    closeRunLogs(runId)
    deps.events.emit('agent.failed', { runId, error })
    if (!updated.ok) return updated
    if (updated.data === null) return missing('Agent run', runId)
    auditRateLimited(updated.data)
    synchronizeTaskStatus(updated.data)
    // TASK-121 (§5.4): a launch-time failure classified as a transient
    // network error is retryable like a post-exit one.
    scheduleTransientRetry(updated.data)
    return { ok: true, data: updated.data }
  }

  /**
   * TASK-107 (§19.3): settles a fail-and-stop run whose process is confirmed
   * dead without a process.exited event ever reaching this instance (queued
   * run, or a previous instance's process). Same durability/notification
   * duties as the process.exited path, with the pre-registered
   * classification instead of a fresh one.
   */
  const settleFailedStop = (
    run: AgentRun,
    classification: AgentFailureClassification,
  ): IpcResult<AgentRun> => {
    const finishedAt = now()
    const error = failStopError(classification)
    appendEvent(run.id, 'agent.failed', { error, classification })
    const updated = deps.runs.update(
      run.id,
      {
        status: 'failed',
        finishedAt,
        error: { ...error },
        failureClassification: classification,
        // TASK-120: a queued run settled by failAndStop leaves the queue.
        queuedReason: null,
      },
      finishedAt,
    )
    activeAdapters.delete(run.id)
    cancelRequested.delete(run.id)
    failStopIntents.delete(run.id)
    if (updated.ok && updated.data !== null) persistRunManifest(updated.data)
    closeRunLogs(run.id)
    collectHandoff(run.id)
    deps.events.emit('agent.failed', { runId: run.id, error })
    if (!updated.ok) return updated
    if (updated.data === null) return missing('Agent run', run.id)
    auditRateLimited(updated.data)
    // TASK-130: cancel the live phase's open decisions BEFORE opening the
    // rate-limit one — cancelBySource must not swallow the decision below.
    cancelRunDecisions(run.id)
    openRateLimitDecision(updated.data)
    synchronizeTaskStatus(updated.data)
    scheduleQueueAdvance()
    return { ok: true, data: updated.data }
  }

  const launch = async (pending: PendingRun): Promise<IpcResult<AgentRun>> => {
    // P0-3: mark the preparing window so failAndStop can refuse to settle a
    // run whose process is only halfway up (see inFlightLaunches above).
    inFlightLaunches.add(pending.request.runId)
    try {
      return await launchInner(pending)
    } finally {
      inFlightLaunches.delete(pending.request.runId)
    }
  }

  const launchInner = async (pending: PendingRun): Promise<IpcResult<AgentRun>> => {
    const { adapter, request } = pending
    const current = deps.runs.getById(request.runId)
    if (!current.ok) return current
    if (current.data === null) return missing('Agent run', request.runId)
    if (current.data.status === 'queued') {
      const timestamp = now()
      // TASK-120: leaving `queued` clears the wait reason.
      const preparing = deps.runs.update(
        request.runId,
        { status: 'preparing', queuedReason: null },
        timestamp,
      )
      if (!preparing.ok) return preparing
      if (preparing.data === null) return missing('Agent run', request.runId)
    }

    activeAdapters.set(request.runId, adapter)
    // TASK-123 (§6.2): attach the structured-stream parser BEFORE the adapter
    // starts so no NDJSON line is missed, and turn off the audit regex for the
    // run — its command audit arrives as agent.command events from tool_call
    // observations (structured source wins, ADR-0013 §3).
    const structuredOutput = request.structuredOutput
    if (structuredOutput !== undefined && structuredOutput.structured !== 'none') {
      deps.observations?.attach(request.runId, structuredOutput.structured)
      deps.permissions?.suppressCommandAudit?.(request.runId)
    }
    const started =
      pending.resumeSession !== undefined && adapter.resume !== undefined
        ? await adapter.resume({
            ...request,
            providerSession: pending.resumeSession,
            ...(pending.resumeProfileContext === undefined
              ? {}
              : { resumeProfileContext: pending.resumeProfileContext }),
          })
        : await adapter.start(request)
    if (!started.ok) return finishFailed(request.runId, started.error)

    const afterStart = deps.runs.getById(request.runId)
    if (!afterStart.ok) return afterStart
    if (afterStart.data !== null && isTerminal(afterStart.data)) {
      // P0-3: the row went terminal while adapter.start was in flight (e.g.
      // the process exited and its exit event settled the row first). The
      // process start DID return a handle — stop it again so nothing leaks,
      // mirroring the cancel-on-failed-write path below. The binding goes
      // FIRST: a cancel that synchronously emits process.exited must find no
      // binding, or the exit handler would settle the row a second time.
      activeAdapters.delete(request.runId)
      await adapter.cancel(request.runId)
      return { ok: true, data: afterStart.data }
    }
    appendEvent(request.runId, pending.resumed ? 'agent.resumed' : 'agent.started', {
      processId: started.data.processId,
      ...(pending.resumed || pending.resumeSession !== undefined
        ? { nativeSession: pending.resumeSession !== undefined }
        : {}),
    })
    // Best-effort: without the token the run keeps the probe-only survivor
    // path at reconciliation; a failed capture must not fail the launch.
    let pidIdentity: string | null = null
    if (deps.hostProcesses !== undefined) {
      const identity = await deps.hostProcesses.identity(started.data.pid)
      if (identity.ok) {
        pidIdentity = identity.data
      } else {
        logger.warn(
          { runId: request.runId, pid: started.data.pid, error: identity.error },
          'Process identity capture failed; the run keeps probe-only survivor handling.',
        )
      }
    }
    // The identity await yields the event loop for real on macOS/Windows
    // (ps / PowerShell spawns): the process may have exited meanwhile and the
    // process.exited path already wrote the terminal status — re-check before
    // writing 'running', same as the post-adapter.start guard above.
    const afterIdentity = deps.runs.getById(request.runId)
    if (!afterIdentity.ok) return afterIdentity
    if (afterIdentity.data !== null && isTerminal(afterIdentity.data)) {
      // Same P0-3 leak guard as the post-adapter.start check above (binding
      // deleted before cancel for the same double-settle reason).
      activeAdapters.delete(request.runId)
      await adapter.cancel(request.runId)
      return { ok: true, data: afterIdentity.data }
    }
    const running = deps.runs.update(
      request.runId,
      {
        status: 'running',
        processId: started.data.processId,
        pid: started.data.pid,
        pidIdentity,
        startedAt: started.data.startedAt,
        ...(pending.resumed
          ? {
              finishedAt: null,
              lastOutputAt: null,
              lastInputAt: null,
              exitCode: null,
              error: null,
            }
          : {}),
        ...(started.data.providerSession === undefined
          ? {}
          : { providerSession: { ...started.data.providerSession } }),
      },
      started.data.startedAt,
    )
    if (!running.ok) {
      // Binding first, cancel second — same double-settle guard as the two
      // P0-3 checks above.
      activeAdapters.delete(request.runId)
      await adapter.cancel(request.runId)
      return running
    }
    if (running.data === null) return missing('Agent run', request.runId)
    persistRunManifest(running.data)
    deps.events.emit('agent.started', { runId: request.runId })
    return { ok: true, data: running.data }
  }

  const advanceQueue = async (): Promise<void> => {
    if (advancingQueue) {
      // The in-flight pass may be reading rows that went stale across one of
      // its awaits (e.g. the per-profile limit lookup); a wake-up landing
      // mid-pass must not be dropped — re-scan once the pass ends.
      advanceAgain = true
      return
    }
    advancingQueue = true
    try {
      do {
        advanceAgain = false
        while (true) {
          const listed = deps.runs.listActive()
          if (!listed.ok) {
            logger.error({ error: listed.error }, 'Failed to read queued Agent runs.')
            return
          }
          const active = runningForLimits(listed.data)
          let selected: { run: AgentRun; pending: PendingRun } | undefined
          for (const run of listed.data.filter((candidate) => candidate.status === 'queued')) {
            const pending = pendingRuns.get(run.id)
            if (pending === undefined) continue
            const policy = resolveConcurrency(run.workspaceId)
            if (!policy.ok) {
              logger.error(
                { runId: run.id, error: policy.error },
                'Failed to resolve Agent concurrency policy.',
              )
              continue
            }
            const profileLimit = await profileRunLimit(run.accountProfileId)
            if (!profileLimit.ok) {
              logger.error(
                { runId: run.id, error: profileLimit.error },
                'Failed to read the account profile concurrency limit.',
              )
              continue
            }
            // TASK-120 (§5.5): a skipped candidate records WHY it was skipped
            // (rewritten only when the reason changes — see updateQueuedReason).
            const skipReason: QueuedReason | undefined =
              unisolatedWriteConflict(active, run.workspaceId, run.worktreeId, run.approvalMode) !==
              undefined
                ? 'directory_busy'
                : // TASK-107 (§19.3): one worktree hosts at most one
                  // non-terminal run; the queued candidate stays queued while
                  // it is occupied.
                  worktreeRunConflict(active, run.worktreeId, run.id) !== undefined
                  ? 'worktree_busy'
                  : !hasCapacity(active, run, policy.data, profileLimit.data)
                    ? 'capacity'
                    : undefined
            if (skipReason !== undefined) {
              updateQueuedReason(run, skipReason)
              continue
            }
            selected = { run, pending }
            break
          }
          if (selected === undefined) break
          pendingRuns.delete(selected.run.id)
          const launched = await launch(selected.pending)
          if (!launched.ok) {
            logger.error(
              { runId: selected.run.id, error: launched.error },
              'Queued Agent run failed to launch.',
            )
          }
        }
      } while (advanceAgain)
    } finally {
      advancingQueue = false
    }
  }

  const scheduleQueueAdvance = (): void => {
    void advanceQueue().catch((cause: unknown) => {
      logger.error({ cause }, 'Unexpected Agent queue advancement failure.')
    })
  }

  /**
   * TASK-121 (Milestone 25 §5.4): pending transient-retry evaluations, tracked
   * so dispose() can cancel a timer that has not fired yet.
   */
  const retryTimers = new Set<ReturnType<typeof setTimeout>>()

  /**
   * TASK-121 (§5.4): count the automatic retries already taken along the
   * `retry_of_run_id` chain leading to this run, bounded by `limit` (the walk
   * is pointless past it). A missing/deleted ancestor ends the chain — the
   * self-FK clears the link ON DELETE SET NULL (migration 017).
   */
  const countRetryChain = (run: AgentRun, limit: number): number => {
    let attempts = 0
    let cursor = run.retryOfRunId
    while (cursor !== undefined && attempts < limit) {
      attempts += 1
      const parent = deps.runs.getById(cursor)
      if (!parent.ok || parent.data === null) break
      cursor = parent.data.retryOfRunId
    }
    return attempts
  }

  /**
   * TASK-121 (§5.4): the narrow auto-retry — ONLY a failed run whose terminal
   * classification is a retryable `network` error, whose handoff did not
   * parse cleanly (a valid handoff is the Agent's own conclusion, §5.4), that
   * no Workflow step claims (the Iterate primitive owns Workflow retries),
   * and whose retry chain is still below `retry.transientAttempts`. The retry
   * itself reuses the TASK-107 continuation mechanism end-to-end (§19.3 flow
   * A survivor judgment, same task/worktree/profile, continuation prompt) —
   * there is no second process-launch path. All gates fail closed: any read
   * error is logged and the run simply stays failed.
   */
  const evaluateTransientRetry = (runId: string): void => {
    const found = deps.runs.getById(runId)
    if (!found.ok) {
      logger.error(
        { runId, error: found.error },
        'Transient-retry evaluation could not read the run.',
      )
      return
    }
    const run = found.data
    if (run === null || run.status !== 'failed') return
    const classification = run.failureClassification
    if (classification?.kind !== 'network' || !classification.retryable) return
    const retry = resolveRetry(run.workspaceId)
    if (!retry.ok) {
      logger.error(
        { runId, error: retry.error },
        'Failed to resolve the retry config; the transient failure is not retried.',
      )
      return
    }
    const maxAttempts = retry.data.transientAttempts
    if (maxAttempts === 0) return
    const handoff = deps.handoffs.getByRunId(run.id)
    if (!handoff.ok) {
      logger.error(
        { runId, error: handoff.error },
        'Transient-retry evaluation could not read the handoff.',
      )
      return
    }
    if (handoff.data?.parseStatus === 'ok') return
    if (run.workflowRunId !== undefined || run.workflowStepId !== undefined) return
    if (deps.workflows !== undefined) {
      const claimed = deps.workflows.hasStepWithAgentRun(run.id)
      if (!claimed.ok) {
        logger.error(
          { runId, error: claimed.error },
          'Transient-retry evaluation could not check Workflow membership.',
        )
        return
      }
      if (claimed.data) return
    }
    const attempt = countRetryChain(run, maxAttempts)
    if (attempt >= maxAttempts) return
    void manager
      .continueWithProfile({
        sourceRunId: run.id,
        targetAgentId: run.agentType,
        // Same identity as the source: a transient network failure is not a
        // reason to switch accounts (§5.4).
        ...(run.accountProfileId === undefined
          ? {}
          : { targetAccountProfileId: run.accountProfileId }),
        ...(run.executionProfileId === undefined
          ? {}
          : { targetExecutionProfileId: run.executionProfileId }),
      })
      .then(
        (continued) => {
          if (!continued.ok) {
            logger.warn(
              { runId, error: continued.error },
              'The transient-failure retry could not create the continuation run.',
            )
            return
          }
          const target = continued.data
          const linked = deps.runs.update(target.id, { retryOfRunId: run.id }, now())
          if (!linked.ok) {
            logger.error(
              { runId, targetRunId: target.id, error: linked.error },
              'Failed to record the retry link on the continuation run.',
            )
            return
          }
          const payload = { sourceRunId: run.id, targetRunId: target.id, attempt: attempt + 1 }
          appendEvent(target.id, 'agent.retry_scheduled', payload)
          deps.events.emit('agent.retry_scheduled', payload)
        },
        (cause: unknown) => {
          logger.error({ runId, cause }, 'Unexpected transient-retry continuation failure.')
        },
      )
  }

  /**
   * TASK-121 (§5.4): defer the evaluation to a macrotask so every microtask
   * the terminal settle triggered has drained first — in particular the
   * Workflow engine's agent-step settlement, which writes the step result
   * (the run→step link the membership gate reads) from a promise
   * continuation of the very `agent.failed` emit above.
   */
  const scheduleTransientRetry = (run: AgentRun): void => {
    if (run.status !== 'failed' || run.failureClassification?.kind !== 'network') return
    const timer = setTimeout(() => {
      retryTimers.delete(timer)
      evaluateTransientRetry(run.id)
    }, 0)
    retryTimers.add(timer)
  }

  const readOutput = (runId: string, tailBytes?: number): IpcResult<string> => {
    outputBatcher.flush(runId)
    const run = deps.runs.getById(runId)
    if (!run.ok) return run
    if (run.data === null) return missing('Agent run', runId)
    // P1-6: terminal.log already holds the exact concatenation of the redacted
    // agent.output payloads — read it (in full, or just the tail) instead of
    // rebuilding one giant string out of every SQLite event row.
    const log = deps.runLogs.readTerminalTail(runId, tailBytes ?? Number.MAX_SAFE_INTEGER)
    if (!log.ok) return log
    if (log.data !== null) return { ok: true, data: log.data }
    // RetentionService (TASK-069) collects terminal.log for old terminal runs
    // but keeps the agent_events rows; only that case falls back to the
    // SQLite reconstruction.
    const history = deps.agentEvents.listByRun(runId)
    if (!history.ok) return history
    return {
      ok: true,
      data: history.data
        .filter(({ eventType }) => eventType === 'agent.output')
        .map(({ payload }) => (typeof payload.data === 'string' ? payload.data : ''))
        .join(''),
    }
  }

  const stopOutput = deps.events.subscribe('process.output', ({ agentRunId, data }) => {
    if (agentRunId === undefined || !activeAdapters.has(agentRunId)) return
    // TASK-123: the observation parser sees the raw chunk BEFORE the 32ms
    // batcher; the terminal.log / readOutput path below is unchanged (ADR-0013
    // §4). ingestChunk never throws and never touches Run state.
    deps.observations?.ingestChunk(agentRunId, data)
    outputBatcher.push(agentRunId, data)
  })

  const stopCommand = deps.events.subscribe('agent.command', ({ runId, command }) => {
    appendEvent(runId, 'agent.command', { command })
  })

  /** TASK-065/077: resolve + project the Run's permission profile (policy only, ADR-0002). */
  const preparePermission = (options: {
    definition: AgentDefinition
    workspaceId: string
    role?: AgentRun['role'] | undefined
    approvalMode: NonNullable<AgentRun['approvalMode']>
    runDir: string
  }) => {
    if (deps.permissions !== undefined) {
      return deps.permissions.prepareRunPermission(options)
    }
    return prepareAgentPermission({
      definition: options.definition,
      profile: permissionProfileForApprovalMode(options.definition.id, options.approvalMode),
      runDir: options.runDir,
    })
  }

  /**
   * Milestone 24 §13 (TASK-100): project a resolved account profile into the
   * launch-slot env via the agent's AccountProfileAdapter.
   */
  const projectProfileForLaunch = (
    agentType: string,
    profile: AgentAccountProfile,
    workspaceRuntime: WorkspaceRuntimeRef,
  ): IpcResult<Record<string, string>> => {
    const profileAdapter = deps.accountProfiles?.adapterFor(agentType)
    if (profileAdapter === undefined) {
      return fail({
        code: 'CAPABILITY_NOT_AVAILABLE',
        message: `No account profile adapter is registered for agent "${agentType}".`,
        retryable: false,
        detail: `cannot project profile ${profile.id}: no AccountProfileAdapter for ${agentType}`,
      })
    }
    if (deps.resolveRuntime === undefined) {
      return fail({
        code: 'UNKNOWN',
        message: 'The workspace runtime is unavailable for account profile projection.',
        retryable: true,
        detail: 'AgentManager has no resolveRuntime for account profile projection',
      })
    }
    const runtime = deps.resolveRuntime(workspaceRuntime)
    if (!runtime.ok) return runtime
    const projection = profileAdapter.buildRuntimeProjection(profile, runtime.data)
    return projection.ok ? { ok: true, data: { ...projection.data.env } } : projection
  }

  /**
   * Milestone 24 §7/§13/§14 (TASK-100/110): run the profile selectors for a
   * start request and, when profiles are selected, project the account env
   * and capture the Run snapshot. The legacy path (no profiles) returns
   * all-undefined so the launch stays byte-identical to pre-profile behavior
   * (§50.1/§52).
   *
   * §14 order: the execution profile resolves FIRST; its account feeds the
   * §37 account selector unless the request pins accountProfileId explicitly
   * (Run explicit override > ExecutionProfile.account > Agent default). Every
   * override is recorded in the snapshot as resolved.
   */
  const resolveStartProfile = async (
    request: StartAgentRunRequest,
    workspaceRuntime: WorkspaceRuntimeRef,
  ): Promise<
    IpcResult<{
      accountProfileId?: string | undefined
      executionProfile?: AgentExecutionProfile | undefined
      /** §14: request.model wins; otherwise the execution profile's model. */
      model?: string | undefined
      profileEnvironment?: Record<string, string> | undefined
      profileSnapshot?: AgentRunProfileSnapshot | undefined
      /** §46.3 (TASK-117): the selected profile's own concurrency limit. */
      maxConcurrentRuns?: number | undefined
    }>
  > => {
    let executionProfile: AgentExecutionProfile | undefined
    if (request.executionProfileId !== undefined) {
      if (deps.executionProfiles === undefined) {
        return fail({
          code: 'CAPABILITY_NOT_AVAILABLE',
          message:
            'Execution profiles are not available in this runtime; the run cannot be started with an explicit execution profile.',
          retryable: false,
          detail: `start with executionProfileId=${request.executionProfileId} but no ExecutionProfileManager composed`,
        })
      }
      const resolvedProfile = await deps.executionProfiles.resolve(
        request.executionProfileId,
        request.agentType,
      )
      if (!resolvedProfile.ok) return resolvedProfile
      executionProfile = resolvedProfile.data
    }
    const model = request.model ?? executionProfile?.model
    if (deps.accountProfiles === undefined) {
      if (request.accountProfileId !== undefined) {
        return fail({
          code: 'CAPABILITY_NOT_AVAILABLE',
          message:
            'Account profiles are not available in this runtime; the run cannot be started with an explicit account profile.',
          retryable: false,
          detail: `start with accountProfileId=${request.accountProfileId} but no AccountProfileManager composed`,
        })
      }
      if (executionProfile?.accountProfileId !== undefined) {
        return fail({
          code: 'CAPABILITY_NOT_AVAILABLE',
          message:
            'Account profiles are not available in this runtime; the execution profile’s account cannot be resolved.',
          retryable: false,
          detail: `execution profile ${executionProfile.id} references account profile ${executionProfile.accountProfileId} but no AccountProfileManager composed`,
        })
      }
      if (executionProfile === undefined) {
        return { ok: true, data: {} }
      }
      return {
        ok: true,
        data: {
          executionProfile,
          ...(model === undefined ? {} : { model }),
          profileSnapshot: {
            executionProfileId: executionProfile.id,
            executionProfileName: executionProfile.name,
            ...(executionProfile.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: executionProfile.reasoningEffort }),
            ...(model === undefined ? {} : { model }),
          },
        },
      }
    }
    // §14: an explicit request accountProfileId overrides the execution
    // profile's account; the selector's hard rules apply to both (an
    // execution profile pinning a disabled/incompatible account is a config
    // error, never a silent downgrade).
    const resolved = await deps.accountProfiles.resolve(
      request.agentType,
      workspaceRuntime,
      request.accountProfileId ?? executionProfile?.accountProfileId,
    )
    if (!resolved.ok) return resolved
    const profile = resolved.data
    if (profile === undefined && executionProfile === undefined) {
      return { ok: true, data: {} }
    }
    const profileEnvironment =
      profile === undefined
        ? undefined
        : projectProfileForLaunch(request.agentType, profile, workspaceRuntime)
    if (profileEnvironment !== undefined && !profileEnvironment.ok) return profileEnvironment
    // §7/§14: the snapshot records the profiles AS RESOLVED — including when
    // the account selection was an explicit override — so history stays
    // auditable.
    return {
      ok: true,
      data: {
        ...(profile === undefined ? {} : { accountProfileId: profile.id }),
        ...(executionProfile === undefined ? {} : { executionProfile }),
        ...(model === undefined ? {} : { model }),
        ...(profileEnvironment === undefined
          ? {}
          : { profileEnvironment: profileEnvironment.data }),
        profileSnapshot: {
          ...(profile === undefined
            ? {}
            : {
                accountProfileId: profile.id,
                accountProfileName: profile.name,
                runtime: profile.runtime,
                ...(profile.configHome === undefined ? {} : { configHome: profile.configHome }),
              }),
          ...(executionProfile === undefined
            ? {}
            : {
                executionProfileId: executionProfile.id,
                executionProfileName: executionProfile.name,
                ...(executionProfile.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: executionProfile.reasoningEffort }),
              }),
          ...(model === undefined ? {} : { model }),
        },
        ...(profile?.maxConcurrentRuns === undefined
          ? {}
          : { maxConcurrentRuns: profile.maxConcurrentRuns }),
      },
    }
  }

  /**
   * §46.3 (TASK-117): the per-profile concurrency limit for an existing run
   * row (queue advancement / resume). A missing profile row or a profile
   * without a limit reads as "unlimited"; a lookup failure is reported so the
   * caller can skip the candidate instead of guessing.
   */
  const profileRunLimit = async (
    accountProfileId: string | undefined,
  ): Promise<IpcResult<number | undefined>> => {
    if (accountProfileId === undefined || deps.accountProfiles === undefined) {
      return { ok: true, data: undefined }
    }
    const profile = await deps.accountProfiles.get(accountProfileId)
    if (!profile.ok) return profile
    return { ok: true, data: profile.data?.maxConcurrentRuns }
  }

  const stopExited = deps.events.subscribe('process.exited', ({ agentRunId, exitCode, signal }) => {
    if (agentRunId === undefined || !activeAdapters.has(agentRunId)) return
    outputBatcher.flush(agentRunId)
    // TASK-123: flush the observation parser's held tail line BEFORE the
    // failure classification below reads structuredErrorFor — a CLI crash
    // often leaves its final NDJSON error line unterminated.
    deps.observations?.flush(agentRunId)
    // TASK-107 (§19.3): a registered fail-and-stop intent wins over both the
    // plain-cancel and the exit-code branches — the run lands on failed with
    // the pre-registered classification, never on cancelled.
    const failStop = failStopIntents.get(agentRunId)
    failStopIntents.delete(agentRunId)
    const cancelIntent = cancelRequested.delete(agentRunId)
    const cancelled = failStop === undefined && cancelIntent
    const status =
      failStop !== undefined
        ? 'failed'
        : cancelled
          ? 'cancelled'
          : exitCode === 0
            ? 'completed'
            : 'failed'
    const finishedAt = now()
    const error: PublicAppError | undefined =
      failStop !== undefined
        ? failStopError(failStop)
        : status === 'failed'
          ? {
              code: 'UNKNOWN',
              message: `Agent process exited with code ${String(exitCode)}.`,
              retryable: true,
            }
          : undefined
    // TASK-105 (§17.0 (a)): only a FAILED exit is classified — cancelled and
    // completed runs have no failure reason to record. A fail-and-stop run
    // keeps its pre-registered classification; no re-classification.
    const classifier =
      status === 'failed' && failStop === undefined ? failureClassifierFor(agentRunId) : undefined
    const failureClassification =
      failStop ??
      classifier?.classify({
        exitCode,
        ...(signal === undefined ? {} : { signal }),
        outputTail: readClassificationTail(agentRunId),
        ...structuredErrorEvents(agentRunId),
      })
    appendEvent(agentRunId, `agent.${status}`, {
      exitCode,
      ...(signal === undefined ? {} : { signal }),
      ...(error === undefined ? {} : { error }),
    })
    const updated = deps.runs.update(
      agentRunId,
      {
        status,
        exitCode,
        finishedAt,
        ...(error === undefined ? {} : { error: { ...error } }),
        ...(failureClassification === undefined ? {} : { failureClassification }),
      },
      finishedAt,
    )
    activeAdapters.delete(agentRunId)
    if (!updated.ok) {
      logger.error({ runId: agentRunId, error: updated.error }, 'Failed to finish Agent run.')
    } else if (updated.data !== null) {
      persistRunManifest(updated.data)
      auditRateLimited(updated.data)
      // TASK-130: cancel the live phase's open decisions BEFORE opening the
      // rate-limit one — cancelBySource must not swallow the decision below.
      cancelRunDecisions(agentRunId)
      openRateLimitDecision(updated.data)
      synchronizeTaskStatus(updated.data)
    }
    closeRunLogs(agentRunId)
    collectHandoff(agentRunId)
    if (status === 'completed') {
      deps.events.emit('agent.completed', { runId: agentRunId, exitCode })
    } else if (status === 'cancelled') {
      deps.events.emit('agent.cancelled', { runId: agentRunId })
    } else if (error !== undefined) {
      deps.events.emit('agent.failed', { runId: agentRunId, error })
    }
    // TASK-121 (§5.4): schedule AFTER collectHandoff (the handoff gate reads
    // the collected parseStatus) and after the agent.failed emit (the
    // Workflow engine settles its step off that emit; the deferred
    // evaluation then sees the run→step link).
    if (updated.ok && updated.data !== null) scheduleTransientRetry(updated.data)
    scheduleQueueAdvance()
  })

  /**
   * TASK-130 (ADR-0014 §3): the rate_limit resolution actions. 'retry' mirrors
   * the TASK-108 Alert's retry (the renderer's restartAgentRunRequest): a fresh
   * interactive run carrying the terminal run's launch parameters. 'wait' is
   * the no-op (and the §9.1 timeout default); 'continue_with_account' needs the
   * user's target-profile pick — the renderer's ContinueWithAccountModal flow —
   * so Main only records the resolution.
   */
  const stopRateLimitDecisions = deps.decisions?.onResolved('rate_limit', (decision) => {
    if (decision.resolution?.optionId !== 'retry') return
    const runId = decision.runId
    if (runId === undefined) return
    const found = deps.runs.getById(runId)
    if (!found.ok) {
      logger.error({ runId, error: found.error }, 'Rate-limit retry could not read the source run.')
      return
    }
    if (found.data === null) {
      logger.warn({ runId }, 'Rate-limit retry skipped: the source run no longer exists.')
      return
    }
    const source = found.data
    const request: StartAgentRunRequest = {
      workspaceId: source.workspaceId,
      agentType: source.agentType,
      ...(source.taskId === undefined ? {} : { taskId: source.taskId }),
      ...(source.accountProfileId === undefined
        ? {}
        : { accountProfileId: source.accountProfileId }),
      ...(source.executionProfileId === undefined
        ? {}
        : { executionProfileId: source.executionProfileId }),
      ...(source.role === undefined ? {} : { role: source.role }),
      ...(source.model === undefined ? {} : { model: source.model }),
      ...(source.approvalMode === undefined ? {} : { approvalMode: source.approvalMode }),
      executionMode: source.executionMode,
      ...(source.worktreeId === undefined ? {} : { worktreeId: source.worktreeId }),
      ...(source.prompt === undefined ? {} : { prompt: source.prompt }),
      mode: 'interactive',
    }
    void manager.start(request).then((started) => {
      if (!started.ok) {
        logger.error(
          { runId, error: started.error },
          'The rate-limit retry failed to start the new run.',
        )
      }
    })
  })

  /**
   * Explicit user cancel of a run this instance does not own. Its process is
   * either already gone or belongs to a previous instance (e.g. a run
   * reconciliation deliberately left active because its pid identity was
   * unreadable, or one whose survivor could not be terminated). Such a run
   * otherwise has no way out: resume() only accepts interrupted, and it holds
   * a concurrency slot (plus the attended-write conflict) forever. Settling
   * it to 'cancelled' — terminal, hence non-resumable — cannot invite the
   * double-write reconciliation was avoiding, and releases everything it
   * held.
   *
   * Before settling, best-effort stop the previous-instance process — but
   * ONLY with identity verification: terminate when the fresh read matches
   * the recorded token, skip when it is unreadable or does not match (never
   * kill an unverified pid). Either way the settle proceeds; the user's
   * cancel intent must be honored. Concurrency is handled by the caller via
   * the adapterlessCancels claim — this body must run at most once per run.
   */
  const settleAdapterlessCancel = async (run: AgentRun): Promise<IpcResult<AgentRun>> => {
    if (deps.hostProcesses !== undefined && run.pid !== undefined) {
      const identity = await deps.hostProcesses.identity(run.pid)
      if (identity.ok && identity.data !== null && identity.data === run.pidIdentity) {
        const terminated = await deps.hostProcesses.terminate(run.pid)
        if (!terminated.ok) {
          logger.warn(
            { runId: run.id, pid: run.pid, error: terminated.error },
            'Best-effort termination of the previous-instance process failed during cancel.',
          )
        }
      }
    }
    const finishedAt = now()
    appendEvent(run.id, 'agent.cancelled', {})
    const updated = deps.runs.update(run.id, { status: 'cancelled', finishedAt }, finishedAt)
    if (updated.ok && updated.data !== null) persistRunManifest(updated.data)
    closeRunLogs(run.id)
    collectHandoff(run.id)
    deps.events.emit('agent.cancelled', { runId: run.id })
    // TASK-130: the run is terminal — its open decisions are cancelled.
    cancelRunDecisions(run.id)
    if (updated.ok && updated.data !== null) synchronizeTaskStatus(updated.data)
    // This run may have been the zombie blocking the queue: with no process
    // left, no process.exited will ever advance it.
    scheduleQueueAdvance()
    if (!updated.ok) return updated
    return updated.data === null ? missing('Agent run', run.id) : { ok: true, data: updated.data }
  }

  /**
   * The failAndStop body — invoked at most once per run at a time via the
   * failStopInFlights claim (P1-1). See the failAndStop contract on the
   * AgentManager interface.
   */
  const doFailAndStop = async (
    runId: string,
    classification: AgentFailureClassification,
  ): Promise<IpcResult<AgentRun>> => {
    const current = deps.runs.getById(runId)
    if (!current.ok) return current
    if (current.data === null) return missing('Agent run', runId)
    const run = current.data
    // §19.4 row 1: already failed WITH a classification — repeat calls and
    // the common "the process already exited on its own" path succeed
    // without touching anything.
    if (run.status === 'failed' && run.failureClassification !== undefined) {
      return { ok: true, data: run }
    }
    if (isTerminal(run)) {
      // §19.4: completed / cancelled / interrupted (and failed WITHOUT a
      // classification) belong to flow A — failing them is a caller error.
      return fail({
        code: 'VALIDATION_FAILED',
        message: `Agent run "${runId}" is already ${run.status}; continue it directly instead of failing it.`,
        retryable: false,
        detail: `failAndStop run=${runId} status=${run.status} — terminal runs go through continuation flow A`,
      })
    }
    if (run.status === 'queued') {
      // Never launched: there is no process to stop.
      pendingRuns.delete(runId)
      return settleFailedStop(run, classification)
    }
    if (
      (run.status === 'created' || run.status === 'preparing') &&
      run.processId === undefined &&
      inFlightLaunches.has(runId)
    ) {
      // P0-3: the launch is in-flight in THIS instance — the process handle
      // does not exist yet, so there is nothing to stop and settling the row
      // here would leak the process adapter.start is about to return (and
      // let a continuation's target run write the same worktree while the
      // source process lives on). Retryable: once the row reaches running,
      // the normal stop path below applies. A STALE created/preparing row
      // (from a dead instance — not in inFlightLaunches) falls through to
      // the survivor path as before.
      return fail({
        code: 'CONFLICT',
        message: 'The Agent run is still launching; retry the continuation once it is running.',
        retryable: true,
        detail: `failAndStop run=${runId} status=${run.status} with launch in flight`,
      })
    }

    // §19.3: register the terminal intent BEFORE stopping, so the
    // process.exited branch writes failed + classification, not cancelled.
    failStopIntents.set(runId, classification)
    const abort = <T>(result: IpcResult<T>): IpcResult<T> => {
      failStopIntents.delete(runId)
      return result
    }

    if (run.processId !== undefined) {
      if (deps.processes === undefined) {
        return abort(
          fail({
            code: 'CAPABILITY_NOT_AVAILABLE',
            message: 'The Agent process cannot be stopped in this runtime.',
            retryable: false,
            detail: `failAndStop run=${runId} without a ProcessManager`,
          }),
        )
      }
      const stopped = await deps.processes.stop(run.processId)
      if (stopped.ok) {
        // §19.4: a successful stop IS the process exit. The exit event was
        // emitted before stop() returned, so the row is already terminal —
        // the settle below is only the defensive path for an exit event
        // that never reached this instance.
        const settled = deps.runs.getById(runId)
        if (!settled.ok) return settled
        if (settled.data === null) return missing('Agent run', runId)
        if (isTerminal(settled.data)) return { ok: true, data: settled.data }
        return settleFailedStop(settled.data, classification)
      }
      if (stopped.error.code === 'COMMAND_TIMEOUT') {
        // §19.4: the process survived interrupt → terminate → kill — abort.
        return abort(
          fail({
            code: 'COMMAND_TIMEOUT',
            message: 'The source Agent process did not exit in time; the continuation was aborted.',
            retryable: true,
            detail: `failAndStop run=${runId} process=${run.processId} survived the kill ladder`,
          }),
        )
      }
      if (stopped.error.code !== 'PROCESS_NOT_FOUND') {
        return abort(stopped)
      }
      // §19.5: not found only means THIS instance is not managing the
      // process — probe before declaring it dead (below).
    }

    const survivor = await terminateSurvivorProcess(deps.hostProcesses, run)
    if (survivor === 'alive') {
      return abort(
        fail({
          code: 'CONFLICT',
          message:
            'The source Agent process is still alive and could not be terminated; the continuation was aborted.',
          retryable: true,
          detail: `failAndStop run=${runId} pid=${String(run.pid)} survivor=alive`,
        }),
      )
    }
    // P1-1: stop() and the identity probe both yielded the event loop — the
    // row may have been settled meanwhile (a natural exit, a raced cancel).
    // Re-read before writing; settling twice would duplicate the failed
    // write, the agent.failed event, and the rate-limit audit.
    const settled = deps.runs.getById(runId)
    if (!settled.ok) return abort(settled)
    if (settled.data === null) return abort(missing('Agent run', runId))
    if (isTerminal(settled.data)) return abort({ ok: true, data: settled.data })
    // Dead (or just terminated with identity verification): settle the row
    // ourselves — no process.exited event exists for a process this
    // instance never owned.
    return settleFailedStop(settled.data, classification)
  }

  const manager: AgentManager = {
    async start(request) {
      const definition = deps.registry.get(request.agentType)
      const adapter = adapters.get(request.agentType)
      if (definition === undefined || adapter === undefined) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Agent "${request.agentType}" is not registered.`,
          messageKey: 'errorMessage.agentNotRegistered',
          params: { agentType: request.agentType },
          retryable: false,
          detail: `registry=${String(definition !== undefined)} adapter=${String(adapter !== undefined)}`,
        })
      }
      const executionMode = request.executionMode ?? 'attended'
      if (executionMode === 'orchestrated' && request.worktreeId === undefined) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Orchestrated Agent runs require an isolated worktree.',
          messageKey: 'errorMessage.orchestratedRequiresWorktree',
          retryable: false,
          detail: `agent=${request.agentType} workspace=${request.workspaceId} missing worktreeId`,
        })
      }
      const workspace = deps.workspaces.getById(request.workspaceId)
      if (!workspace.ok) return workspace
      if (workspace.data === null) return missing('workspace', request.workspaceId)
      // Milestone 24 §13.2 (TASK-100): reserved account-profile env keys
      // (CODEX_HOME / CLAUDE_CONFIG_DIR) may never come from workspace or
      // request env — reject and log, never silently drop.
      if (deps.accountProfiles !== undefined) {
        const reservedKeys = deps.accountProfiles.reservedEnvKeys()
        for (const [source, env] of [
          ['workspace.env', workspace.data.env],
          ['request.environment', request.environment],
        ] as const) {
          const check = assertNoReservedEnvKeys(env, source, reservedKeys)
          if (!check.ok) {
            logger.warn(
              { workspaceId: workspace.data.id, source, error: check.error },
              'Reserved account-profile env key rejected.',
            )
            return check
          }
        }
      }
      const startProfile = await resolveStartProfile(request, workspace.data.runtime)
      if (!startProfile.ok) return startProfile
      const launchWorkspace = resolveLaunchWorkspace(workspace.data)
      if (!launchWorkspace.ok) return launchWorkspace

      const detected = await adapter.detect({ runtime: workspace.data.runtime })
      if (!detected.ok) return detected
      if (!detected.data.installed) {
        return fail({
          code: 'AGENT_NOT_INSTALLED',
          message: `${definition.name} is not installed in this workspace runtime.`,
          messageKey: 'errorMessage.agentNotInstalled',
          params: { agent: definition.name },
          retryable: false,
          detail: `agent=${definition.id} runtime=${JSON.stringify(workspace.data.runtime)}`,
        })
      }

      let task
      if (request.taskId !== undefined) {
        const found = deps.tasks.getById(request.taskId)
        if (!found.ok) return found
        if (found.data === null) return missing('task', request.taskId)
        if (found.data.workspaceId !== workspace.data.id) {
          return fail({
            code: 'VALIDATION_FAILED',
            message: 'The selected task belongs to a different workspace.',
            messageKey: 'errorMessage.taskWorkspaceMismatch',
            retryable: false,
            detail: `task workspace=${found.data.workspaceId} run workspace=${workspace.data.id}`,
          })
        }
        task = found.data
      }

      let worktreePath: string | undefined
      if (request.worktreeId !== undefined) {
        const found = deps.worktrees.getById(request.worktreeId)
        if (!found.ok) return found
        if (found.data === null) return missing('worktree', request.worktreeId)
        if (found.data.workspaceId !== workspace.data.id) {
          return fail({
            code: 'VALIDATION_FAILED',
            message: 'The selected worktree belongs to a different workspace.',
            messageKey: 'errorMessage.worktreeWorkspaceMismatch',
            retryable: false,
            detail: `worktree workspace=${found.data.workspaceId} run workspace=${workspace.data.id}`,
          })
        }
        worktreePath = found.data.path
      }

      const mode = request.mode ?? 'interactive'
      if (!definition.capabilities[mode === 'exec' ? 'headless' : 'interactive']) {
        return fail({
          code: 'CAPABILITY_NOT_AVAILABLE',
          message: `${definition.name} does not support ${mode} mode.`,
          messageKey: 'errorMessage.agentModeUnsupported',
          params: { agent: definition.name, mode },
          retryable: false,
          detail: `AgentDefinition ${definition.id} capability ${mode}=false`,
        })
      }
      const defaultApproval = approvalModeSchema.safeParse(definition.defaults.permissionProfile)
      // §14 (TASK-110): request approvalMode wins; otherwise the execution
      // profile's; otherwise the agent default. The result feeds the same
      // permission-projection channel as before (preparePermission below).
      const approvalMode =
        request.approvalMode ??
        startProfile.data.executionProfile?.approvalMode ??
        (defaultApproval.success ? defaultApproval.data : 'manual')
      const policy = resolveConcurrency(workspace.data.id)
      if (!policy.ok) return policy
      const listed = deps.runs.listActive()
      if (!listed.ok) return listed
      const active = runningForLimits(listed.data)
      const conflict = unisolatedWriteConflict(
        active,
        workspace.data.id,
        request.worktreeId,
        approvalMode,
      )
      if (conflict !== undefined) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Agent run "${conflict.id}" is already modifying this workspace directly. Stop it before starting another writable Agent, or use an isolated worktree.`,
          messageKey: 'errorMessage.attendedRunConflict',
          params: { runId: conflict.id },
          retryable: true,
          detail: `workspace=${workspace.data.id} conflicting run=${conflict.id}`,
        })
      }
      // TASK-107 (§19.3): one worktree hosts at most one non-terminal run.
      const worktreeConflict = worktreeRunConflict(active, request.worktreeId)
      if (worktreeConflict !== undefined) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Agent run "${worktreeConflict.id}" is still active on this worktree. Stop it before starting another run here.`,
          params: { runId: worktreeConflict.id },
          retryable: true,
          detail: `worktree=${request.worktreeId ?? ''} conflicting run=${worktreeConflict.id}`,
        })
      }
      const queuedReason = queueEntryReason(
        listed.data,
        hasCapacity(
          active,
          {
            workspaceId: workspace.data.id,
            agentType: definition.id,
            ...(startProfile.data.accountProfileId === undefined
              ? {}
              : { accountProfileId: startProfile.data.accountProfileId }),
          },
          policy.data,
          startProfile.data.maxConcurrentRuns,
        ),
      )
      const shouldQueue = queuedReason !== undefined
      // TASK-052: services that pre-bind resources to the Run (ReviewerService
      // snapshot worktree) supply runId; direct IPC callers leave it to us.
      const runId = request.runId ?? createRunId()
      const runDirectory = deps.paths.runDir(runId)
      if (!runDirectory.ok) return runDirectory
      const role = request.role ?? definition.defaults.role
      const timestamp = now()
      const created = deps.runs.create(
        {
          id: runId,
          workspaceId: workspace.data.id,
          agentType: definition.id,
          executionMode,
          runDir: runDirectory.data,
          status: shouldQueue ? 'queued' : 'preparing',
          // TASK-120 (§5.5): the queue-entry reason rides the INSERT.
          ...(queuedReason === undefined ? {} : { queuedReason }),
          // ADR-0007: persist the resolved launch mode so resume can reuse it.
          mode,
          ...(role === undefined ? {} : { role }),
          approvalMode,
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
          ...(request.worktreeId === undefined ? {} : { worktreeId: request.worktreeId }),
          ...(startProfile.data.model === undefined ? {} : { model: startProfile.data.model }),
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
          ...(startProfile.data.accountProfileId === undefined
            ? {}
            : { accountProfileId: startProfile.data.accountProfileId }),
          ...(startProfile.data.executionProfile === undefined
            ? {}
            : { executionProfileId: startProfile.data.executionProfile.id }),
          ...(startProfile.data.profileSnapshot === undefined
            ? {}
            : { profileSnapshot: startProfile.data.profileSnapshot }),
        },
        timestamp,
      )
      if (!created.ok) return created
      const initialized = deps.runLogs.initialize(created.data)
      if (!initialized.ok) {
        deps.runs.delete(runId)
        return initialized
      }
      const runFiles = deps.paths.runFiles(runId)
      if (!runFiles.ok) {
        deps.runs.delete(runId)
        return runFiles
      }
      // TASK-077 (ADR-0002): project the resolved permission profile onto the
      // Agent CLI's own mechanism before launch. `none`-enforcement agents get
      // no projection — nothing is generated that claims to constrain them.
      // TASK-065: the profile comes from the PermissionManager's layered rules
      // when it is composed in; otherwise it's the bare approval-mode default.
      const permission = preparePermission({
        definition,
        workspaceId: workspace.data.id,
        ...(role === undefined ? {} : { role }),
        approvalMode,
        runDir: runDirectory.data,
      })
      if (!permission.ok) {
        deps.runs.delete(runId)
        return permission
      }
      appendEvent(runId, 'agent.created', { agentType: definition.id, executionMode })
      deps.events.emit('agent.created', { runId })
      // TASK-116 (§41): audit which account identity the Run was launched
      // with — explicit pin, execution-profile account, or agent default
      // (§14/§37), recorded as resolved.
      if (
        startProfile.data.accountProfileId !== undefined &&
        startProfile.data.profileSnapshot !== undefined
      ) {
        appendAccountEvent({
          profileId: startProfile.data.accountProfileId,
          runId,
          eventType: 'agent.profile_selected',
          payload: {
            agentType: definition.id,
            accountProfileId: startProfile.data.accountProfileId,
            accountProfileName: startProfile.data.profileSnapshot.accountProfileName,
            source:
              request.accountProfileId !== undefined
                ? 'explicit'
                : startProfile.data.executionProfile?.accountProfileId !== undefined
                  ? 'execution-profile'
                  : 'default',
            ...(startProfile.data.executionProfile === undefined
              ? {}
              : {
                  executionProfileId: startProfile.data.executionProfile.id,
                  executionProfileName: startProfile.data.executionProfile.name,
                }),
            ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
          },
        })
      }
      synchronizeTaskStatus(created.data)

      // TASK-122 (§6.1): resolve the structured-output protocol once, with the
      // exec-mode and observability.structuredStream gates applied.
      const structuredOutput = resolveStructuredOutput(definition, mode, workspace.data.id)
      // TASK-139: a Main-internal caller (user-message continuation) may ask
      // the NEW run to resume the source run's native provider session. When
      // the agent cannot resume natively the continuation still launches —
      // the Handoff-backed prompt carries the context (§39 fallback).
      const nativeResume =
        request.resumeSession !== undefined &&
        definition.capabilities.resume &&
        adapter.resume !== undefined
      if (request.resumeSession !== undefined && !nativeResume) {
        logger.warn(
          { agentType: definition.id },
          'A session resume was requested for an agent without native resume support; launching with the context prompt instead.',
        )
      }
      const pending: PendingRun = {
        adapter,
        resumed: false,
        ...(nativeResume && request.resumeSession !== undefined
          ? { resumeSession: request.resumeSession }
          : {}),
        ...(nativeResume && request.resumeProfileContext !== undefined
          ? { resumeProfileContext: request.resumeProfileContext }
          : {}),
        request: {
          runId,
          workspace: launchWorkspace.data,
          ...(task === undefined ? {} : { task }),
          mode,
          approvalMode,
          ...(structuredOutput === undefined ? {} : { structuredOutput }),
          ...(permission.data === undefined
            ? {}
            : {
                permissionProfile: permission.data.profile,
                ...(permission.data.configPath === undefined
                  ? {}
                  : { permissionConfigPath: permission.data.configPath }),
              }),
          ...(startProfile.data.model === undefined ? {} : { model: startProfile.data.model }),
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
          ...(worktreePath === undefined ? {} : { worktreePath }),
          handoffPath: runFiles.data.handoff,
          artifactDir: runFiles.data.artifacts,
          progressPath: runFiles.data.progress,
          ...(request.environment === undefined ? {} : { environment: request.environment }),
          ...(startProfile.data.profileEnvironment === undefined
            ? {}
            : { profileEnvironment: startProfile.data.profileEnvironment }),
        },
      }
      if (shouldQueue) {
        pendingRuns.set(runId, pending)
        appendEvent(runId, 'agent.queued', {})
        deps.events.emit('agent.queued', { runId })
        scheduleQueueAdvance()
        return created
      }

      const launched = await launch(pending)
      if (!launched.ok) scheduleQueueAdvance()
      return launched
    },

    async resume(request) {
      const current = deps.runs.getById(request.runId)
      if (!current.ok) return current
      if (current.data === null) return missing('Agent run', request.runId)
      const run = current.data
      if (run.status !== 'interrupted') {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Only interrupted Agent runs can be resumed.',
          messageKey: 'errorMessage.onlyInterruptedResumable',
          retryable: false,
          detail: `run=${run.id} status=${run.status}`,
        })
      }

      const definition = deps.registry.get(run.agentType)
      const adapter = adapters.get(run.agentType)
      if (definition === undefined || adapter === undefined) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Agent "${run.agentType}" is not registered.`,
          messageKey: 'errorMessage.agentNotRegistered',
          params: { agentType: run.agentType },
          retryable: false,
          detail: `resume run=${run.id}`,
        })
      }
      const workspace = deps.workspaces.getById(run.workspaceId)
      if (!workspace.ok) return workspace
      if (workspace.data === null) return missing('workspace', run.workspaceId)
      // Milestone 24 §13.2 (TASK-100): the same reserved-key rejection as
      // start() — a workspace that gained CODEX_HOME / CLAUDE_CONFIG_DIR
      // after the run was created must not retarget the resumed process at
      // another account's CLI home either (P1-4).
      if (deps.accountProfiles !== undefined) {
        const check = assertNoReservedEnvKeys(
          workspace.data.env,
          'workspace.env',
          deps.accountProfiles.reservedEnvKeys(),
        )
        if (!check.ok) {
          logger.warn(
            { workspaceId: workspace.data.id, source: 'workspace.env', error: check.error },
            'Reserved account-profile env key rejected.',
          )
          return check
        }
      }
      const launchWorkspace = resolveLaunchWorkspace(workspace.data)
      if (!launchWorkspace.ok) return launchWorkspace
      const detected = await adapter.detect({ runtime: workspace.data.runtime, refresh: true })
      if (!detected.ok) return detected
      if (!detected.data.installed) {
        return fail({
          code: 'AGENT_NOT_INSTALLED',
          message: `${definition.name} is not installed in this workspace runtime.`,
          messageKey: 'errorMessage.agentNotInstalled',
          params: { agent: definition.name },
          retryable: false,
          detail: `resume run=${run.id} agent=${definition.id}`,
        })
      }

      // Detection is the only async gap in resume(); a concurrent resume (or
      // any other lifecycle transition) may have moved the Run off
      // 'interrupted' while it was in flight. Everything below is synchronous
      // up to the status transition, so re-checking here means exactly one
      // caller relaunches the Run — a second ProcessManager.start would
      // collide on the process id and fail the Run the first caller just
      // relaunched.
      const recheck = deps.runs.getById(request.runId)
      if (!recheck.ok) return recheck
      if (recheck.data === null) return missing('Agent run', request.runId)
      if (recheck.data.status !== 'interrupted') {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Only interrupted Agent runs can be resumed.',
          messageKey: 'errorMessage.onlyInterruptedResumable',
          retryable: false,
          detail: `resume run=${run.id} status=${recheck.data.status} after detection`,
        })
      }

      // Milestone 24 §38/§39 (TASK-100/112): resume restores the HISTORICAL
      // runtime identity from the run row (accountProfileId + profileSnapshot)
      // — never the current agent default. A run without an account profile
      // resumes legacy, projecting nothing.
      let profileEnvironment: Record<string, string> | undefined
      let resumeProfileContext: AgentResumeProfileContext | undefined
      let resumeProfileMaxConcurrentRuns: number | undefined
      if (run.accountProfileId !== undefined) {
        if (deps.accountProfiles === undefined || deps.resolveRuntime === undefined) {
          return fail({
            code: 'CAPABILITY_NOT_AVAILABLE',
            message:
              'Account profiles are unavailable; the run cannot be resumed with its historical identity.',
            retryable: true,
            detail: `resume run=${run.id} profile=${run.accountProfileId} without account profile support`,
          })
        }
        const profileRow = await deps.accountProfiles.get(run.accountProfileId)
        if (!profileRow.ok) return profileRow
        // P1-4 (§65 scenario G / §10.5): a user-driven resume of a run whose
        // profile is now DISABLED is refused — the §37 selector rejects the
        // same profile at start, and §38 historical restoration does not
        // extend to re-entering a disabled identity. The "row deleted →
        // restore from snapshot" path below is unchanged.
        if (profileRow.data !== null && profileRow.data.enabled === false) {
          return fail({
            code: 'ACCOUNT_PROFILE_DISABLED',
            message:
              'The account profile this run used is disabled, so the run cannot be resumed. Start a Continuation run with a different account instead.',
            retryable: false,
            detail: `resume run=${run.id} profile=${run.accountProfileId} disabled`,
          })
        }
        // P1-4: the same §37 step-0 judgment as start, over the HISTORICAL
        // runtime — a workspace re-pointed at another runtime (windows → wsl)
        // must not have the old config home (e.g. C:\...) injected into the
        // new runtime's process, where the CLI would silently fall back to
        // its default home.
        const historicalRuntime = profileRow.data?.runtime ?? run.profileSnapshot?.runtime
        if (
          historicalRuntime !== undefined &&
          !isHistoricalRuntimeCompatible(historicalRuntime, workspace.data.runtime)
        ) {
          return fail({
            code: 'ACCOUNT_PROFILE_INCOMPATIBLE',
            message:
              'The account identity this run used belongs to a different runtime than the workspace now uses, so the run cannot be resumed. Start a Continuation run instead.',
            retryable: false,
            detail: `resume run=${run.id} historical=${JSON.stringify(historicalRuntime)} workspace=${JSON.stringify(workspace.data.runtime)}`,
          })
        }
        resumeProfileMaxConcurrentRuns = profileRow.data?.maxConcurrentRuns
        const profileAdapter = deps.accountProfiles.adapterFor(run.agentType)
        if (profileAdapter === undefined) {
          return fail({
            code: 'CAPABILITY_NOT_AVAILABLE',
            message: `No account profile adapter is registered for agent "${run.agentType}".`,
            retryable: false,
            detail: `resume run=${run.id} profile=${run.accountProfileId}`,
          })
        }
        const profileRuntime = deps.resolveRuntime(workspace.data.runtime)
        if (!profileRuntime.ok) return profileRuntime
        const identity = projectHistoricalProfileIdentity({
          run,
          profile: profileRow.data,
          adapter: profileAdapter,
          runtime: profileRuntime.data,
          workspaceRuntime: workspace.data.runtime,
        })
        if (!identity.ok) return identity
        profileEnvironment = identity.data.env
        resumeProfileContext = identity.data.resumeProfileContext
      }

      const task = run.taskId === undefined ? undefined : deps.tasks.getById(run.taskId)
      if (task !== undefined && !task.ok) return task
      if (task !== undefined && task.data === null) return missing('task', run.taskId as string)
      const worktree =
        run.worktreeId === undefined ? undefined : deps.worktrees.getById(run.worktreeId)
      if (worktree !== undefined && !worktree.ok) return worktree
      if (worktree !== undefined && worktree.data === null) {
        return missing('worktree', run.worktreeId as string)
      }

      const policy = resolveConcurrency(run.workspaceId)
      if (!policy.ok) return policy
      const listed = deps.runs.listActive()
      if (!listed.ok) return listed
      const active = runningForLimits(listed.data)
      const conflict = unisolatedWriteConflict(
        active,
        run.workspaceId,
        run.worktreeId,
        run.approvalMode,
      )
      if (conflict !== undefined) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Agent run "${conflict.id}" is already modifying this workspace directly.`,
          messageKey: 'errorMessage.attendedRunConflictResume',
          params: { runId: conflict.id },
          retryable: true,
          detail: `resume run=${run.id} conflict=${conflict.id}`,
        })
      }
      // TASK-107 (§19.3): one worktree hosts at most one non-terminal run.
      const resumeWorktreeConflict = worktreeRunConflict(active, run.worktreeId, run.id)
      if (resumeWorktreeConflict !== undefined) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Agent run "${resumeWorktreeConflict.id}" is still active on this worktree. Stop it before resuming here.`,
          params: { runId: resumeWorktreeConflict.id },
          retryable: true,
          detail: `resume run=${run.id} worktree=${run.worktreeId ?? ''} conflict=${resumeWorktreeConflict.id}`,
        })
      }
      const resumeQueuedReason = queueEntryReason(
        listed.data,
        hasCapacity(active, run, policy.data, resumeProfileMaxConcurrentRuns),
      )
      const shouldQueue = resumeQueuedReason !== undefined

      const parsedSession = providerSessionRefSchema.safeParse(run.providerSession)
      const resumeSession =
        definition.capabilities.resume && adapter.resume !== undefined && parsedSession.success
          ? parsedSession.data
          : undefined
      let prompt = request.prompt
      if (resumeSession === undefined) {
        // P1-6: the resume context only keeps the last
        // RESUME_OUTPUT_CONTEXT_CHARS characters, so read a bounded tail of
        // terminal.log (4 bytes/char covers the worst UTF-8 case) instead of
        // reconstructing the run's entire output first.
        const output = readOutput(run.id, RESUME_OUTPUT_CONTEXT_CHARS * 4)
        if (!output.ok) return output
        const handoff = deps.handoffs.getByRunId(run.id)
        if (!handoff.ok) return handoff
        prompt = buildResumeContext(
          run,
          output.data,
          buildHandoffContext(handoff.data),
          request.prompt,
        )
      }

      const runFiles = deps.paths.runFiles(run.id)
      if (!runFiles.ok) return runFiles
      // TASK-077: re-project the persisted approval mode on resume so the
      // relaunched process gets the same CLI-side policy as the original run.
      const resumeDefaultApproval = approvalModeSchema.safeParse(
        definition.defaults.permissionProfile,
      )
      const resumeApprovalMode =
        run.approvalMode ?? (resumeDefaultApproval.success ? resumeDefaultApproval.data : 'manual')
      const resumePermission = preparePermission({
        definition,
        workspaceId: run.workspaceId,
        ...(run.role === undefined ? {} : { role: run.role }),
        approvalMode: resumeApprovalMode,
        runDir: runFiles.data.directory,
      })
      if (!resumePermission.ok) return resumePermission
      // ADR-0007: relaunch with the run's original mode — an exec run that
      // comes back interactive would idle at the prompt forever. Runs
      // predating 009 (no recorded mode) and CLIs without headless support
      // keep the pre-ADR interactive behavior.
      const resumeMode =
        run.mode === 'exec' && definition.capabilities.headless ? 'exec' : 'interactive'
      // TASK-122 (§6.1): same structured-output resolution as start().
      const resumeStructuredOutput = resolveStructuredOutput(
        definition,
        resumeMode,
        run.workspaceId,
      )
      const pending: PendingRun = {
        adapter,
        resumed: true,
        ...(resumeSession === undefined ? {} : { resumeSession }),
        ...(resumeProfileContext === undefined ? {} : { resumeProfileContext }),
        request: {
          runId: run.id,
          workspace: launchWorkspace.data,
          ...(task?.data === null || task?.data === undefined ? {} : { task: task.data }),
          mode: resumeMode,
          approvalMode: run.approvalMode,
          ...(resumeStructuredOutput === undefined
            ? {}
            : { structuredOutput: resumeStructuredOutput }),
          ...(resumePermission.data === undefined
            ? {}
            : {
                permissionProfile: resumePermission.data.profile,
                ...(resumePermission.data.configPath === undefined
                  ? {}
                  : { permissionConfigPath: resumePermission.data.configPath }),
              }),
          model: run.model,
          prompt,
          ...(worktree?.data === null || worktree?.data === undefined
            ? {}
            : { worktreePath: worktree.data.path }),
          handoffPath: runFiles.data.handoff,
          artifactDir: runFiles.data.artifacts,
          progressPath: runFiles.data.progress,
          ...(profileEnvironment === undefined ? {} : { profileEnvironment }),
        },
      }
      const timestamp = now()
      const prepared = deps.runs.update(
        run.id,
        {
          status: shouldQueue ? 'queued' : 'preparing',
          // TASK-120: a re-queued resume records the entry reason; a directly
          // relaunched one clears whatever the interrupted row still carried.
          queuedReason: resumeQueuedReason ?? null,
          processId: null,
          pid: null,
          pidIdentity: null,
          finishedAt: null,
          exitCode: null,
          error: null,
          // A resumed run starts a fresh attempt: the previous attempt's
          // failure classification (e.g. rate-limited) is stale and must not
          // keep driving rate-limit logic (§18 projections, the RateLimitAlert)
          // for the relaunched run.
          failureClassification: null,
        },
        timestamp,
      )
      if (!prepared.ok) return prepared
      if (prepared.data === null) return missing('Agent run', run.id)
      appendEvent(run.id, 'agent.resume_requested', {
        nativeSession: resumeSession !== undefined,
      })
      persistRunManifest(prepared.data)
      synchronizeTaskStatus(prepared.data)

      if (shouldQueue) {
        pendingRuns.set(run.id, pending)
        appendEvent(run.id, 'agent.queued', { resumed: true })
        deps.events.emit('agent.queued', { runId: run.id })
        scheduleQueueAdvance()
        return { ok: true, data: prepared.data }
      }
      return launch(pending)
    },

    async send({ runId, data }) {
      const adapter = activeAdapters.get(runId)
      if (adapter === undefined) {
        return fail({
          code: 'PROCESS_NOT_FOUND',
          message: `Agent run "${runId}" is not active.`,
          messageKey: 'errorMessage.agentRunNotActive',
          params: { runId },
          retryable: false,
          detail: 'No active Adapter binding exists for run input.',
        })
      }
      outputBatcher.flush(runId)
      const sent = await adapter.send(runId, data)
      if (!sent.ok) return sent
      appendEvent(runId, 'agent.input', { data })
      const timestamp = now()
      const updated = deps.runs.update(runId, { lastInputAt: timestamp }, timestamp)
      if (!updated.ok) return updated
      if (updated.data !== null) persistRunManifest(updated.data)
      return { ok: true, data: undefined }
    },

    resize({ runId, cols, rows }) {
      const adapter = activeAdapters.get(runId)
      if (adapter === undefined) {
        return fail({
          code: 'PROCESS_NOT_FOUND',
          message: `Agent run "${runId}" is not active.`,
          messageKey: 'errorMessage.agentRunNotActive',
          params: { runId },
          retryable: false,
          detail: 'No active Adapter binding exists for run resize.',
        })
      }
      // Adapters without a live PTY (e.g. test doubles) accept resize as a no-op.
      return adapter.resize?.(runId, cols, rows) ?? { ok: true, data: undefined }
    },

    async cancel(runId) {
      const current = deps.runs.getById(runId)
      if (!current.ok) return current
      if (current.data === null) return missing('Agent run', runId)
      if (isTerminal(current.data)) return { ok: true, data: current.data }
      if (current.data.status === 'queued') {
        pendingRuns.delete(runId)
        const finishedAt = now()
        appendEvent(runId, 'agent.cancelled', {})
        const updated = deps.runs.update(
          runId,
          { status: 'cancelled', finishedAt, queuedReason: null },
          finishedAt,
        )
        if (updated.ok && updated.data !== null) persistRunManifest(updated.data)
        closeRunLogs(runId)
        deps.events.emit('agent.cancelled', { runId })
        // TASK-130: the run is terminal — its open decisions are cancelled.
        cancelRunDecisions(runId)
        if (updated.ok && updated.data !== null) synchronizeTaskStatus(updated.data)
        scheduleQueueAdvance()
        if (!updated.ok) return updated
        return updated.data === null
          ? missing('Agent run', runId)
          : { ok: true, data: updated.data }
      }
      const adapter = activeAdapters.get(runId)
      if (adapter === undefined) {
        // Claim the settle BEFORE any await: a concurrent cancel() awaits the
        // same execution instead of running its own identity read and
        // terminate against the same pid (the first terminate's success lets
        // the OS recycle the pid, and a second terminate could land on an
        // unrelated new process — exactly what this whole chain guards
        // against).
        const inFlight = adapterlessCancels.get(runId)
        if (inFlight !== undefined) return inFlight
        const pending = settleAdapterlessCancel(current.data)
        adapterlessCancels.set(runId, pending)
        try {
          return await pending
        } finally {
          adapterlessCancels.delete(runId)
        }
      }

      outputBatcher.flush(runId)
      cancelRequested.add(runId)
      const cancelled = await adapter.cancel(runId)
      if (!cancelled.ok) {
        cancelRequested.delete(runId)
        return cancelled
      }
      const after = deps.runs.getById(runId)
      if (!after.ok) return after
      if (after.data !== null && isTerminal(after.data)) {
        return { ok: true, data: after.data }
      }

      const finishedAt = now()
      appendEvent(runId, 'agent.cancelled', {})
      const updated = deps.runs.update(runId, { status: 'cancelled', finishedAt }, finishedAt)
      cancelRequested.delete(runId)
      activeAdapters.delete(runId)
      if (updated.ok && updated.data !== null) persistRunManifest(updated.data)
      closeRunLogs(runId)
      collectHandoff(runId)
      deps.events.emit('agent.cancelled', { runId })
      // TASK-130: the run is terminal — its open decisions are cancelled.
      cancelRunDecisions(runId)
      if (updated.ok && updated.data !== null) synchronizeTaskStatus(updated.data)
      if (!updated.ok) return updated
      return updated.data === null ? missing('Agent run', runId) : { ok: true, data: updated.data }
    },

    async failAndStop(runId, classification) {
      // P1-1: claim the in-flight slot BEFORE any await — a concurrent
      // failAndStop of the same run awaits this execution instead of
      // re-running the stop + settle (which would write failed, append
      // agent.failed, and audit agent.rate_limited a second time).
      const inFlight = failStopInFlights.get(runId)
      if (inFlight !== undefined) return inFlight
      const pending = doFailAndStop(runId, classification)
      failStopInFlights.set(runId, pending)
      try {
        return await pending
      } finally {
        failStopInFlights.delete(runId)
      }
    },

    async continueWithProfile(request) {
      const current = deps.runs.getById(request.sourceRunId)
      if (!current.ok) return current
      if (current.data === null) return missing('Agent run', request.sourceRunId)
      let source = current.data
      const sourceWasLive = !isTerminal(source)

      if (sourceWasLive && request.reason === 'user-message') {
        // TASK-139 (Milestone 26 §9, P1-2 principle): a thread message never
        // stops or classifies a running round — reject outright so the user
        // can resend when the current round settles. Nothing is written.
        return fail({
          code: 'CONFLICT',
          message:
            'The previous round is still running. Wait for it to finish before sending another message.',
          messageKey: 'errorMessage.threadRoundStillRunning',
          retryable: true,
          detail: `user-message continuation refused for live source run=${source.id}`,
        })
      }

      if (sourceWasLive) {
        // §19.3 flow B: the source is still running — fail it with a
        // classification first (failAndStop is the ONLY writer of
        // failed + classification on a live run).
        // P1-2: the output-tail text classifier only runs when the caller
        // DECLARED a rate limit — §17.0 lets a human confirm "switch", not
        // confirm "this really is a quota error" on the classifier's behalf.
        // A plain manual switch registers an explicit unknown classification
        // so the §18 projection's default branch (no status change) applies
        // and the source profile is never mislabeled limited.
        const classification: AgentFailureClassification =
          request.reason === 'rate-limit'
            ? (failureClassifierFor(source.id)?.classify({
                outputTail: readClassificationTail(source.id),
                ...structuredErrorEvents(source.id),
              }) ?? { kind: 'unknown', retryable: true })
            : { kind: 'unknown', retryable: true }
        const stopped = await manager.failAndStop(source.id, classification)
        if (!stopped.ok) return stopped
        source = stopped.data
      } else if (
        source.pid !== undefined &&
        source.exitCode === undefined &&
        source.pidIdentity !== undefined
      ) {
        // §19.3 flow A step 1: a terminal row alone does not prove the
        // process is gone (a settle path may have finalized the row while a
        // survivor lived on) — verify with the same pid-identity judgment
        // reconciliation uses before reusing the worktree.
        // P2-12: a recorded exit code already proves the process exited, and
        // a terminal LEGACY row (pre-migration-011, no identity token) must
        // never be probed/killed — the pid may have been reused by an
        // unrelated process. Only an identity-verifiable row without an exit
        // code is worth probing.
        const survivor = await terminateSurvivorProcess(deps.hostProcesses, source)
        if (survivor === 'alive') {
          return fail({
            code: 'CONFLICT',
            message:
              'The source Agent process is still alive and could not be terminated; the continuation was aborted.',
            retryable: true,
            detail: `continue run=${source.id} pid=${String(source.pid)} survivor=alive`,
          })
        }
      }

      // §41: the reason rides both audit events and the continuation context.
      // Flow A (the source was ALREADY terminal): the persisted terminal
      // classification is the only truth — a caller-declared reason derived
      // before the source settled (e.g. 'manual-switch' from a modal opened
      // while the run was still live, which then finished rate-limited) must
      // not overwrite it. Flow B (live source, no terminal classification
      // yet): the caller's declared reason wins, with the just-registered
      // classification as the fallback. TASK-139: 'user-message' is caller
      // truth by construction (the user's message exists regardless of how
      // the source settled) and always wins in flow A.
      const reason: AgentContinuationReason =
        request.reason === 'user-message'
          ? 'user-message'
          : sourceWasLive && request.reason !== undefined
            ? request.reason
            : deriveContinuationReason(source)

      // §20: the continuation context package (best-effort enrichments — a
      // missing handoff / artifact / criteria read never blocks the switch).
      const outputTail = readClassificationTail(source.id)
      const handoff = deps.handoffs.getByRunId(source.id)
      if (!handoff.ok) return handoff
      const artifactIds = deps.artifacts?.listByRun(source.id)
      if (artifactIds !== undefined && !artifactIds.ok) return artifactIds
      let acceptanceCriteria: unknown[] | undefined
      if (source.criteriaSetId !== undefined && deps.criteria !== undefined) {
        const criteria = deps.criteria.listCriteria(source.criteriaSetId)
        if (!criteria.ok) return criteria
        acceptanceCriteria = criteria.data.map((criterion) => ({
          id: criterion.id,
          description: criterion.description,
          required: criterion.required,
        }))
      }
      const continuation = buildAgentContinuation({
        sourceRun: source,
        reason,
        handoff: handoff.data,
        ...(artifactIds === undefined
          ? {}
          : { artifactIds: artifactIds.data.map((artifact) => artifact.id) }),
        ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
        outputTail,
      })
      const prompt = buildContinuationPrompt(continuation, {
        ...(source.prompt === undefined ? {} : { originalPrompt: source.prompt }),
        outputTail,
        ...(request.userMessage === undefined ? {} : { userMessage: request.userMessage }),
      })

      // TASK-139 (Milestone 26 §9): a user-message continuation resumes the
      // source run's NATIVE provider session — same agent, same account (the
      // send-message gate guarantees both), so the §10.5 identity context is
      // the source row's own. The profile row's current configHome feeds the
      // drift check: an edited/deleted profile makes the adapter refuse
      // loudly instead of resuming against the wrong CLI home.
      let resumeSession: ProviderSessionRef | undefined
      let resumeProfileContext: AgentResumeProfileContext | undefined
      if (reason === 'user-message') {
        const parsedSession = providerSessionRefSchema.safeParse(source.providerSession)
        if (parsedSession.success) {
          resumeSession = parsedSession.data
          if (source.accountProfileId !== undefined && deps.accountProfiles !== undefined) {
            const profileRow = await deps.accountProfiles.get(source.accountProfileId)
            if (!profileRow.ok) return profileRow
            const snapshotConfigHome = source.profileSnapshot?.configHome
            const currentConfigHome = profileRow.data?.configHome ?? snapshotConfigHome
            resumeProfileContext = {
              accountProfileId: source.accountProfileId,
              ...(snapshotConfigHome === undefined ? {} : { snapshotConfigHome }),
              ...(currentConfigHome === undefined ? {} : { currentConfigHome }),
            }
          }
        }
      }

      // §19.3 steps 3–4 / §21: same task, same worktree (the reservation
      // invariant is enforced inside start), NEW run under the target
      // identity. The §37 selector inside start validates
      // targetAccountProfileId against targetAgentId (match / enabled /
      // runtime compatibility).
      const started = await manager.start({
        workspaceId: source.workspaceId,
        agentType: request.targetAgentId,
        ...(source.taskId === undefined ? {} : { taskId: source.taskId }),
        ...(source.worktreeId === undefined ? {} : { worktreeId: source.worktreeId }),
        executionMode: source.executionMode,
        ...(source.mode === undefined ? {} : { mode: source.mode }),
        // TASK-110 (§14): a target execution profile supplies model /
        // approvalMode itself — forwarding the source run's values would
        // override the profile the user explicitly switched to.
        ...(request.targetExecutionProfileId === undefined && source.approvalMode !== undefined
          ? { approvalMode: source.approvalMode }
          : {}),
        ...(request.targetExecutionProfileId === undefined && source.model !== undefined
          ? { model: source.model }
          : {}),
        ...(request.targetAccountProfileId === undefined
          ? {}
          : { accountProfileId: request.targetAccountProfileId }),
        ...(request.targetExecutionProfileId === undefined
          ? {}
          : { executionProfileId: request.targetExecutionProfileId }),
        ...(resumeSession === undefined ? {} : { resumeSession }),
        ...(resumeProfileContext === undefined ? {} : { resumeProfileContext }),
        prompt,
      })
      if (!started.ok) return started
      const target = started.data

      // P1-11 (docs/code-review-2026-09-21.md §3): the continuation link is
      // a DURABLE Run event on the target run — the account_events audit
      // below is best-effort and must not be the only place the
      // source/target association exists (§41).
      appendEvent(target.id, 'agent.continued', {
        sourceRunId: source.id,
        reason,
        ...(source.accountProfileId === undefined
          ? {}
          : { previousAccountProfileId: source.accountProfileId }),
      })

      // §41: both continuation audit events are keyed to the target run;
      // the payload carries both sides of the switch.
      const auditPayload = {
        ...(source.taskId === undefined ? {} : { taskId: source.taskId }),
        sourceRunId: source.id,
        targetRunId: target.id,
        reason,
      }
      appendAccountEvent({
        ...(target.accountProfileId === undefined ? {} : { profileId: target.accountProfileId }),
        runId: target.id,
        eventType: 'agent.continuation_created',
        payload: {
          ...auditPayload,
          previousAgentId: source.agentType,
          targetAgentId: target.agentType,
          ...(source.accountProfileId === undefined
            ? {}
            : { previousAccountProfileId: source.accountProfileId }),
          ...(target.accountProfileId === undefined
            ? {}
            : { targetAccountProfileId: target.accountProfileId }),
        },
      })
      if (source.accountProfileId !== target.accountProfileId) {
        appendAccountEvent({
          ...(target.accountProfileId === undefined ? {} : { profileId: target.accountProfileId }),
          runId: target.id,
          eventType: 'agent.account_switched',
          payload: {
            ...auditPayload,
            ...(source.accountProfileId === undefined ? {} : { from: source.accountProfileId }),
            ...(target.accountProfileId === undefined ? {} : { to: target.accountProfileId }),
          },
        })
      }
      return { ok: true, data: target }
    },

    get: (runId) => deps.runs.getById(runId),
    getOutput: (runId, options) => readOutput(runId, options?.tailBytes),

    list(request = {}) {
      if (request.activeOnly === true) {
        const active = deps.runs.listActive()
        if (!active.ok) return active
        return {
          ok: true,
          data: active.data.filter(
            (run) =>
              (request.workspaceId === undefined || run.workspaceId === request.workspaceId) &&
              (request.taskId === undefined || run.taskId === request.taskId),
          ),
        }
      }
      if (request.taskId !== undefined) {
        const taskRuns = deps.runs.listByTask(request.taskId)
        if (!taskRuns.ok || request.workspaceId === undefined) return taskRuns
        return {
          ok: true,
          data: taskRuns.data.filter((run) => run.workspaceId === request.workspaceId),
        }
      }
      if (request.workspaceId === undefined) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'A workspace is required when listing historical Agent runs.',
          messageKey: 'errorMessage.workspaceRequiredForRunHistory',
          retryable: false,
          detail: 'list({ activeOnly: false }) omitted workspaceId',
        })
      }
      return deps.runs.listByWorkspace(request.workspaceId)
    },

    async dispose() {
      // P0-2: quitting must not leak Agent processes. Cancel every run with a
      // live Adapter binding; the process.exited path settles each run's
      // terminal status (cancelled) and collects its handoff while the event
      // subscriptions are still in place. Queued runs never launched a
      // process, so startup reconciliation owns their fate.
      await Promise.all(
        [...activeAdapters.keys()].map(async (runId) => {
          const cancelled = await manager.cancel(runId)
          if (!cancelled.ok) {
            logger.error(
              { runId, error: cancelled.error },
              'Failed to stop an Agent run during shutdown.',
            )
          }
        }),
      )
      // Adapterless cancels hold no adapter binding, so the loop above does
      // not cover them — but once their identity probe resumes they still
      // write to the DB and the run logs. Wait them out before anything is
      // closed, or the settle lands on a closed database and the cancelled
      // run comes back as a zombie on the next start.
      await Promise.all([...adapterlessCancels.values()])
      // Same drain for in-flight fail-and-stops: they settle rows and close
      // run logs, so they must finish before the database/log handles close.
      await Promise.all([...failStopInFlights.values()])
      stopOutput()
      stopCommand()
      stopExited()
      // TASK-130: detach the rate_limit resolution subscription.
      stopRateLimitDecisions?.()
      activeAdapters.clear()
      pendingRuns.clear()
      cancelRequested.clear()
      failStopIntents.clear()
      adapterlessCancels.clear()
      failStopInFlights.clear()
      inFlightLaunches.clear()
      // TASK-121: a retry timer that has not fired yet must not evaluate
      // against closed handles after shutdown.
      for (const timer of retryTimers) clearTimeout(timer)
      retryTimers.clear()
      // Drain the output the cancels produced only AFTER unsubscribing: the
      // subscription is the batcher's only push source, so from here no 32ms
      // batch timer can fire past the log close below.
      outputBatcher.flushAll()
      // P1-1: final durability checkpoint — fsync anything the throttle left
      // dirty and release every log handle before the data root is touched.
      const closed = deps.runLogs.disposeAll()
      if (!closed.ok) {
        logger.error({ error: closed.error }, 'Failed to flush Run logs during shutdown.')
      }
    },
  }

  return manager
}
