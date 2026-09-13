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
  type AgentResumeProfileContext,
  type AgentRun,
  type AgentRunProfileSnapshot,
  type ConcurrencyConfig,
  type ContinueAgentRunRequest,
  type IpcResult,
  type ListAgentRunsRequest,
  type ProviderSessionRef,
  type PublicAppError,
  type ResizeAgentRunRequest,
  type ResumeAgentRunRequest,
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
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { WorktreeRepository } from '../db/repositories/worktree-repository'
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
import { projectHistoricalProfileIdentity } from './accounts/runtime-identity'
import type { WorkspaceRuntime } from '../workspace/runtime'

export interface AgentManager {
  start(request: StartAgentRunRequest): Promise<IpcResult<AgentRun>>
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
   * TASK-105 (§17 / ADR-0010): per-agent failure classifiers. Runs of an
   * agent without a registered classifier keep a NULL
   * failure_classification_json — classification is best-effort metadata,
   * never a lifecycle gate.
   */
  readonly failureClassifiers?: readonly AgentFailureClassifier[]
  /** Resolves the workspace runtime object for profile env projection (§13). */
  readonly resolveRuntime?: (ref: WorkspaceRuntimeRef) => IpcResult<WorkspaceRuntime>
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

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
  const createRunId = deps.createRunId ?? randomUUID
  const now = deps.now ?? (() => new Date().toISOString())
  const resolveConcurrency =
    deps.resolveConcurrency ?? (() => ({ ok: true, data: DEFAULT_CONFIG.concurrency }))
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

  const finishFailed = (runId: string, error: PublicAppError): IpcResult<AgentRun> => {
    const finishedAt = now()
    // TASK-105: a launch-time failure has no exit code; the adapter error
    // plus whatever output exists still feeds the classifier (§17.2).
    const classifier = failureClassifierFor(runId)
    const failureClassification = classifier?.classify({
      outputTail: [readClassificationTail(runId), error.message]
        .filter((part) => part.length > 0)
        .join('\n'),
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
      { status: 'failed', finishedAt, error: { ...error }, failureClassification: classification },
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
    synchronizeTaskStatus(updated.data)
    scheduleQueueAdvance()
    return { ok: true, data: updated.data }
  }

  const launch = async (pending: PendingRun): Promise<IpcResult<AgentRun>> => {
    const { adapter, request } = pending
    const current = deps.runs.getById(request.runId)
    if (!current.ok) return current
    if (current.data === null) return missing('Agent run', request.runId)
    if (current.data.status === 'queued') {
      const timestamp = now()
      const preparing = deps.runs.update(request.runId, { status: 'preparing' }, timestamp)
      if (!preparing.ok) return preparing
      if (preparing.data === null) return missing('Agent run', request.runId)
    }

    activeAdapters.set(request.runId, adapter)
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
      return { ok: true, data: afterStart.data }
    }
    appendEvent(request.runId, pending.resumed ? 'agent.resumed' : 'agent.started', {
      processId: started.data.processId,
      ...(pending.resumed ? { nativeSession: pending.resumeSession !== undefined } : {}),
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
      await adapter.cancel(request.runId)
      activeAdapters.delete(request.runId)
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
            if (
              unisolatedWriteConflict(active, run.workspaceId, run.worktreeId, run.approvalMode) ===
                undefined &&
              // TASK-107 (§19.3): one worktree hosts at most one non-terminal
              // run; the queued candidate stays queued while it is occupied.
              worktreeRunConflict(active, run.worktreeId, run.id) === undefined &&
              hasCapacity(active, run, policy.data, profileLimit.data)
            ) {
              selected = { run, pending }
              break
            }
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
   * Milestone 24 §7/§13/§14 (TASK-100): run the §37 selector for a start
   * request and, when a profile is selected, project its env and capture the
   * Run snapshot. The legacy path (no profile) returns all-undefined so the
   * launch stays byte-identical to pre-profile behavior (§50.1/§52).
   */
  const resolveStartProfile = async (
    request: StartAgentRunRequest,
    workspaceRuntime: WorkspaceRuntimeRef,
  ): Promise<
    IpcResult<{
      accountProfileId?: string | undefined
      profileEnvironment?: Record<string, string> | undefined
      profileSnapshot?: AgentRunProfileSnapshot | undefined
      /** §46.3 (TASK-117): the selected profile's own concurrency limit. */
      maxConcurrentRuns?: number | undefined
    }>
  > => {
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
      return { ok: true, data: {} }
    }
    const resolved = await deps.accountProfiles.resolve(
      request.agentType,
      workspaceRuntime,
      request.accountProfileId,
    )
    if (!resolved.ok) return resolved
    const profile = resolved.data
    if (profile === undefined) {
      return { ok: true, data: {} }
    }
    const env = projectProfileForLaunch(request.agentType, profile, workspaceRuntime)
    if (!env.ok) return env
    // §7/§14: the snapshot records the profile AS RESOLVED — including when
    // the selection was an explicit override — so history stays auditable.
    return {
      ok: true,
      data: {
        accountProfileId: profile.id,
        profileEnvironment: env.data,
        profileSnapshot: {
          accountProfileId: profile.id,
          accountProfileName: profile.name,
          runtime: profile.runtime,
          ...(profile.configHome === undefined ? {} : { configHome: profile.configHome }),
          ...(request.model === undefined ? {} : { model: request.model }),
        },
        ...(profile.maxConcurrentRuns === undefined
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
    scheduleQueueAdvance()
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
    if (updated.ok && updated.data !== null) synchronizeTaskStatus(updated.data)
    // This run may have been the zombie blocking the queue: with no process
    // left, no process.exited will ever advance it.
    scheduleQueueAdvance()
    if (!updated.ok) return updated
    return updated.data === null ? missing('Agent run', run.id) : { ok: true, data: updated.data }
  }

  const manager: AgentManager = {
    async start(request) {
      // Milestone 24 (TASK-100 scope boundary): ExecutionProfiles only exist
      // from TASK-109/110 — refuse loudly instead of silently dropping the
      // field and launching with an unintended identity.
      if (request.executionProfileId !== undefined) {
        return fail({
          code: 'CAPABILITY_NOT_AVAILABLE',
          message: 'Execution profiles are not supported yet.',
          retryable: false,
          detail: `start with executionProfileId=${request.executionProfileId} before TASK-110`,
        })
      }
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
      const approvalMode =
        request.approvalMode ?? (defaultApproval.success ? defaultApproval.data : 'manual')
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
      const shouldQueue =
        listed.data.some((run) => run.status === 'queued') ||
        !hasCapacity(
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
        )
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
          // ADR-0007: persist the resolved launch mode so resume can reuse it.
          mode,
          ...(role === undefined ? {} : { role }),
          approvalMode,
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
          ...(request.worktreeId === undefined ? {} : { worktreeId: request.worktreeId }),
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
          ...(startProfile.data.accountProfileId === undefined
            ? {}
            : { accountProfileId: startProfile.data.accountProfileId }),
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
      // with — explicit pin or agent default (§37), recorded as resolved.
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
            source: request.accountProfileId !== undefined ? 'explicit' : 'default',
            ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
          },
        })
      }
      synchronizeTaskStatus(created.data)

      const pending: PendingRun = {
        adapter,
        resumed: false,
        request: {
          runId,
          workspace: launchWorkspace.data,
          ...(task === undefined ? {} : { task }),
          mode,
          approvalMode,
          ...(permission.data === undefined
            ? {}
            : {
                permissionProfile: permission.data.profile,
                ...(permission.data.configPath === undefined
                  ? {}
                  : { permissionConfigPath: permission.data.configPath }),
              }),
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
          ...(worktreePath === undefined ? {} : { worktreePath }),
          handoffPath: runFiles.data.handoff,
          artifactDir: runFiles.data.artifacts,
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
      const shouldQueue =
        listed.data.some((candidate) => candidate.status === 'queued') ||
        !hasCapacity(active, run, policy.data, resumeProfileMaxConcurrentRuns)

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
      const pending: PendingRun = {
        adapter,
        resumed: true,
        ...(resumeSession === undefined ? {} : { resumeSession }),
        ...(resumeProfileContext === undefined ? {} : { resumeProfileContext }),
        request: {
          runId: run.id,
          workspace: launchWorkspace.data,
          ...(task?.data === null || task?.data === undefined ? {} : { task: task.data }),
          // ADR-0007: relaunch with the run's original mode — an exec run that
          // comes back interactive would idle at the prompt forever. Runs
          // predating 009 (no recorded mode) and CLIs without headless support
          // keep the pre-ADR interactive behavior.
          mode: run.mode === 'exec' && definition.capabilities.headless ? 'exec' : 'interactive',
          approvalMode: run.approvalMode,
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
          ...(profileEnvironment === undefined ? {} : { profileEnvironment }),
        },
      }
      const timestamp = now()
      const prepared = deps.runs.update(
        run.id,
        {
          status: shouldQueue ? 'queued' : 'preparing',
          processId: null,
          pid: null,
          pidIdentity: null,
          finishedAt: null,
          exitCode: null,
          error: null,
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
        const updated = deps.runs.update(runId, { status: 'cancelled', finishedAt }, finishedAt)
        if (updated.ok && updated.data !== null) persistRunManifest(updated.data)
        closeRunLogs(runId)
        deps.events.emit('agent.cancelled', { runId })
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
      if (updated.ok && updated.data !== null) synchronizeTaskStatus(updated.data)
      if (!updated.ok) return updated
      return updated.data === null ? missing('Agent run', runId) : { ok: true, data: updated.data }
    },

    async failAndStop(runId, classification) {
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
              message:
                'The source Agent process did not exit in time; the continuation was aborted.',
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
      // Dead (or just terminated with identity verification): settle the row
      // ourselves — no process.exited event exists for a process this
      // instance never owned.
      return settleFailedStop(run, classification)
    },

    async continueWithProfile(request) {
      const current = deps.runs.getById(request.sourceRunId)
      if (!current.ok) return current
      if (current.data === null) return missing('Agent run', request.sourceRunId)
      let source = current.data

      if (!isTerminal(source)) {
        // §19.3 flow B: the source is still running — fail it with a
        // classification first (failAndStop is the ONLY writer of
        // failed + classification on a live run).
        const classifier = failureClassifierFor(source.id)
        const classification: AgentFailureClassification = classifier?.classify({
          outputTail: readClassificationTail(source.id),
        }) ?? { kind: 'unknown', retryable: true }
        const stopped = await manager.failAndStop(source.id, classification)
        if (!stopped.ok) return stopped
        source = stopped.data
      } else if (source.pid !== undefined) {
        // §19.3 flow A step 1: a terminal row alone does not prove the
        // process is gone (a settle path may have finalized the row while a
        // survivor lived on) — verify with the same pid-identity judgment
        // reconciliation uses before reusing the worktree.
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
      const reason: AgentContinuationReason =
        source.failureClassification?.kind === 'rate-limited'
          ? 'rate-limit'
          : source.status === 'failed'
            ? 'agent-failure'
            : 'manual-switch'

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
      })

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
        ...(source.approvalMode === undefined ? {} : { approvalMode: source.approvalMode }),
        ...(source.model === undefined ? {} : { model: source.model }),
        ...(request.targetAccountProfileId === undefined
          ? {}
          : { accountProfileId: request.targetAccountProfileId }),
        ...(request.targetExecutionProfileId === undefined
          ? {}
          : { executionProfileId: request.targetExecutionProfileId }),
        prompt,
      })
      if (!started.ok) return started
      const target = started.data

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
      stopOutput()
      stopCommand()
      stopExited()
      activeAdapters.clear()
      pendingRuns.clear()
      cancelRequested.clear()
      failStopIntents.clear()
      adapterlessCancels.clear()
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
