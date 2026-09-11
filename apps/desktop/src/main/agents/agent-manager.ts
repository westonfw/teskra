import { randomUUID } from 'node:crypto'

import {
  approvalModeSchema,
  DEFAULT_CONFIG,
  isWorkspaceSecretRef,
  providerSessionRefSchema,
  type AgentDefinition,
  type AgentStartRequest,
  type AgentRun,
  type ConcurrencyConfig,
  type IpcResult,
  type ListAgentRunsRequest,
  type ProviderSessionRef,
  type PublicAppError,
  type ResumeAgentRunRequest,
  type SendAgentRunInputRequest,
  type StartAgentRunRequest,
  type TaskStatus,
  type WorkbenchEvents,
  type Workspace,
} from '@teskra/contracts'

import type { AgentEventRepository } from '../db/repositories/agent-event-repository'
import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { HandoffRepository } from '../db/repositories/handoff-repository'
import type { TaskRepository } from '../db/repositories/task-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { WorktreeRepository } from '../db/repositories/worktree-repository'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { TeskraPaths } from '../paths'
import { buildHandoffContext } from '@teskra/shared'
import { resolveEnvReferences, type CredentialStore } from '../security/credential-store'
import type { AgentRegistry } from './agent-registry'
import { createAgentOutputBatcher } from './agent-output-batcher'
import { createHandoffCollector, type HandoffCollector } from './handoff-collector'
import type { AgentPermissionPreparer } from '../permissions/permission-manager'
import {
  prepareAgentPermission,
  permissionProfileForApprovalMode,
} from './permissions/permission-projection'
import type { ReviewCollector } from './review-collector'
import type { RunLogStore } from './run-log-store'
import type { CodingAgentAdapter } from './adapters/coding-agent-adapter'

export interface AgentManager {
  start(request: StartAgentRunRequest): Promise<IpcResult<AgentRun>>
  resume(request: ResumeAgentRunRequest): Promise<IpcResult<AgentRun>>
  send(request: SendAgentRunInputRequest): Promise<IpcResult<void>>
  cancel(runId: string): Promise<IpcResult<AgentRun>>
  get(runId: string): IpcResult<AgentRun | null>
  list(request?: ListAgentRunsRequest): IpcResult<AgentRun[]>
  getOutput(runId: string): IpcResult<string>
  dispose(): void
}

export interface AgentManagerDeps {
  readonly registry: AgentRegistry
  readonly adapters: readonly CodingAgentAdapter[]
  readonly runs: AgentRunRepository
  readonly agentEvents: AgentEventRepository
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
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function missing(kind: string, id: string): IpcResult<never> {
  return fail({
    code: kind === 'workspace' ? 'WORKSPACE_NOT_FOUND' : 'VALIDATION_FAILED',
    message: `${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)} "${id}" was not found.`,
    retryable: false,
    detail: `AgentManager could not resolve ${kind} id=${JSON.stringify(id)}`,
  })
}

function isTerminal(run: AgentRun): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
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

function hasCapacity(
  runs: readonly AgentRun[],
  candidate: { workspaceId: string; agentType: string },
  policy: ConcurrencyConfig,
): boolean {
  return (
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
}

const RESUME_OUTPUT_CONTEXT_CHARS = 6_000

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
  const activeAdapters = new Map<string, CodingAgentAdapter>()
  const pendingRuns = new Map<string, PendingRun>()
  const cancelRequested = new Set<string>()
  const createRunId = deps.createRunId ?? randomUUID
  const now = deps.now ?? (() => new Date().toISOString())
  const resolveConcurrency =
    deps.resolveConcurrency ?? (() => ({ ok: true, data: DEFAULT_CONFIG.concurrency }))
  const handoffCollector =
    deps.handoffCollector ??
    createHandoffCollector({ handoffs: deps.handoffs, paths: deps.paths, now })
  let advancingQueue = false

  /**
   * TASK-088: returns the workspace with env secret refs replaced by their
   * resolved plaintext for process launch. Workspaces without refs pass
   * through untouched.
   */
  const resolveLaunchWorkspace = (workspace: Workspace): IpcResult<Workspace> => {
    if (
      workspace.env === undefined ||
      !Object.values(workspace.env).some(isWorkspaceSecretRef)
    ) {
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

  const persistRunManifest = (run: AgentRun): void => {
    const written = deps.runLogs.writeRun(run)
    if (!written.ok) {
      logger.error({ runId: run.id, error: written.error }, 'Failed to update Run manifest.')
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
    } else if (updated.data !== null) {
      persistRunManifest(updated.data)
    }
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

  const finishFailed = (runId: string, error: PublicAppError): IpcResult<AgentRun> => {
    const finishedAt = now()
    appendEvent(runId, 'agent.failed', { error })
    const updated = deps.runs.update(
      runId,
      { status: 'failed', finishedAt, error: { ...error } },
      finishedAt,
    )
    activeAdapters.delete(runId)
    if (updated.ok && updated.data !== null) persistRunManifest(updated.data)
    deps.events.emit('agent.failed', { runId, error })
    if (!updated.ok) return updated
    if (updated.data === null) return missing('Agent run', runId)
    synchronizeTaskStatus(updated.data)
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
        ? await adapter.resume({ ...request, providerSession: pending.resumeSession })
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
    const running = deps.runs.update(
      request.runId,
      {
        status: 'running',
        processId: started.data.processId,
        pid: started.data.pid,
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
    if (advancingQueue) return
    advancingQueue = true
    try {
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
          if (
            unisolatedWriteConflict(active, run.workspaceId, run.worktreeId, run.approvalMode) ===
              undefined &&
            hasCapacity(active, run, policy.data)
          ) {
            selected = { run, pending }
            break
          }
        }
        if (selected === undefined) return
        pendingRuns.delete(selected.run.id)
        const launched = await launch(selected.pending)
        if (!launched.ok) {
          logger.error(
            { runId: selected.run.id, error: launched.error },
            'Queued Agent run failed to launch.',
          )
        }
      }
    } finally {
      advancingQueue = false
    }
  }

  const scheduleQueueAdvance = (): void => {
    void advanceQueue().catch((cause: unknown) => {
      logger.error({ cause }, 'Unexpected Agent queue advancement failure.')
    })
  }

  const readOutput = (runId: string): IpcResult<string> => {
    outputBatcher.flush(runId)
    const run = deps.runs.getById(runId)
    if (!run.ok) return run
    if (run.data === null) return missing('Agent run', runId)
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
    role?: AgentRun['role']
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

  const stopExited = deps.events.subscribe('process.exited', ({ agentRunId, exitCode, signal }) => {
    if (agentRunId === undefined || !activeAdapters.has(agentRunId)) return
    outputBatcher.flush(agentRunId)
    const cancelled = cancelRequested.delete(agentRunId)
    const status = cancelled ? 'cancelled' : exitCode === 0 ? 'completed' : 'failed'
    const finishedAt = now()
    const error: PublicAppError | undefined =
      status === 'failed'
        ? {
            code: 'UNKNOWN',
            message: `Agent process exited with code ${String(exitCode)}.`,
            retryable: true,
          }
        : undefined
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
      },
      finishedAt,
    )
    activeAdapters.delete(agentRunId)
    if (!updated.ok) {
      logger.error({ runId: agentRunId, error: updated.error }, 'Failed to finish Agent run.')
    } else if (updated.data !== null) {
      persistRunManifest(updated.data)
      synchronizeTaskStatus(updated.data)
    }
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

  return {
    async start(request) {
      const definition = deps.registry.get(request.agentType)
      const adapter = adapters.get(request.agentType)
      if (definition === undefined || adapter === undefined) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Agent "${request.agentType}" is not registered.`,
          retryable: false,
          detail: `registry=${String(definition !== undefined)} adapter=${String(adapter !== undefined)}`,
        })
      }
      const executionMode = request.executionMode ?? 'attended'
      if (executionMode === 'orchestrated' && request.worktreeId === undefined) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Orchestrated Agent runs require an isolated worktree.',
          retryable: false,
          detail: `agent=${request.agentType} workspace=${request.workspaceId} missing worktreeId`,
        })
      }
      const workspace = deps.workspaces.getById(request.workspaceId)
      if (!workspace.ok) return workspace
      if (workspace.data === null) return missing('workspace', request.workspaceId)
      const launchWorkspace = resolveLaunchWorkspace(workspace.data)
      if (!launchWorkspace.ok) return launchWorkspace

      const detected = await adapter.detect({ runtime: workspace.data.runtime })
      if (!detected.ok) return detected
      if (!detected.data.installed) {
        return fail({
          code: 'AGENT_NOT_INSTALLED',
          message: `${definition.name} is not installed in this workspace runtime.`,
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
          retryable: true,
          detail: `workspace=${workspace.data.id} conflicting run=${conflict.id}`,
        })
      }
      const shouldQueue =
        listed.data.some((run) => run.status === 'queued') ||
        !hasCapacity(
          active,
          { workspaceId: workspace.data.id, agentType: definition.id },
          policy.data,
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
          ...(role === undefined ? {} : { role }),
          approvalMode,
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
          ...(request.worktreeId === undefined ? {} : { worktreeId: request.worktreeId }),
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
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
          retryable: false,
          detail: `resume run=${run.id} agent=${definition.id}`,
        })
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
          retryable: true,
          detail: `resume run=${run.id} conflict=${conflict.id}`,
        })
      }
      const shouldQueue =
        listed.data.some((candidate) => candidate.status === 'queued') ||
        !hasCapacity(active, run, policy.data)

      const parsedSession = providerSessionRefSchema.safeParse(run.providerSession)
      const resumeSession =
        definition.capabilities.resume && adapter.resume !== undefined && parsedSession.success
          ? parsedSession.data
          : undefined
      let prompt = request.prompt
      if (resumeSession === undefined) {
        const output = readOutput(run.id)
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
      const resumeDefaultApproval = approvalModeSchema.safeParse(definition.defaults.permissionProfile)
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
        request: {
          runId: run.id,
          workspace: launchWorkspace.data,
          ...(task?.data === null || task?.data === undefined ? {} : { task: task.data }),
          mode: 'interactive',
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
        },
      }
      const timestamp = now()
      const prepared = deps.runs.update(
        run.id,
        {
          status: shouldQueue ? 'queued' : 'preparing',
          processId: null,
          pid: null,
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
        return fail({
          code: 'PROCESS_NOT_FOUND',
          message: `Agent run "${runId}" has no active process.`,
          retryable: false,
          detail: 'Persisted active run is missing its Adapter binding.',
        })
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
      collectHandoff(runId)
      deps.events.emit('agent.cancelled', { runId })
      if (updated.ok && updated.data !== null) synchronizeTaskStatus(updated.data)
      if (!updated.ok) return updated
      return updated.data === null ? missing('Agent run', runId) : { ok: true, data: updated.data }
    },

    get: (runId) => deps.runs.getById(runId),

    getOutput: readOutput,

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
          retryable: false,
          detail: 'list({ activeOnly: false }) omitted workspaceId',
        })
      }
      return deps.runs.listByWorkspace(request.workspaceId)
    },

    dispose() {
      stopOutput()
      stopCommand()
      stopExited()
      outputBatcher.flushAll()
      activeAdapters.clear()
      pendingRuns.clear()
      cancelRequested.clear()
    },
  }
}
