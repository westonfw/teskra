import { randomUUID } from 'node:crypto'

import {
  approvalModeSchema,
  DEFAULT_CONFIG,
  type AgentStartRequest,
  type AgentRun,
  type ConcurrencyConfig,
  type IpcResult,
  type ListAgentRunsRequest,
  type PublicAppError,
  type SendAgentRunInputRequest,
  type StartAgentRunRequest,
  type WorkbenchEvents,
} from '@teskra/contracts'

import type { AgentEventRepository } from '../db/repositories/agent-event-repository'
import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { TaskRepository } from '../db/repositories/task-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { WorktreeRepository } from '../db/repositories/worktree-repository'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { TeskraPaths } from '../paths'
import type { AgentRegistry } from './agent-registry'
import type { CodingAgentAdapter } from './adapters/coding-agent-adapter'

export interface AgentManager {
  start(request: StartAgentRunRequest): Promise<IpcResult<AgentRun>>
  send(request: SendAgentRunInputRequest): Promise<IpcResult<void>>
  cancel(runId: string): Promise<IpcResult<AgentRun>>
  get(runId: string): IpcResult<AgentRun | null>
  list(request?: ListAgentRunsRequest): IpcResult<AgentRun[]>
  dispose(): void
}

export interface AgentManagerDeps {
  readonly registry: AgentRegistry
  readonly adapters: readonly CodingAgentAdapter[]
  readonly runs: AgentRunRepository
  readonly agentEvents: AgentEventRepository
  readonly workspaces: WorkspaceRepository
  readonly tasks: TaskRepository
  readonly worktrees: WorktreeRepository
  readonly events: EventBus<WorkbenchEvents>
  readonly paths: TeskraPaths
  readonly createRunId?: () => string
  readonly now?: () => string
  readonly resolveConcurrency?: (workspaceId: string) => IpcResult<ConcurrencyConfig>
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
  let advancingQueue = false

  const appendEvent = (
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): void => {
    const next = deps.agentEvents.nextSeq(runId)
    if (!next.ok) {
      logger.error({ runId, eventType, error: next.error }, 'Failed to allocate Agent event seq.')
      return
    }
    const appended = deps.agentEvents.append({ runId, seq: next.data, eventType, payload }, now())
    if (!appended.ok) {
      logger.error({ runId, eventType, error: appended.error }, 'Failed to persist Agent event.')
    }
  }

  const finishFailed = (runId: string, error: PublicAppError): IpcResult<AgentRun> => {
    const finishedAt = now()
    const updated = deps.runs.update(
      runId,
      { status: 'failed', finishedAt, error: { ...error } },
      finishedAt,
    )
    activeAdapters.delete(runId)
    appendEvent(runId, 'agent.failed', { error })
    deps.events.emit('agent.failed', { runId, error })
    if (!updated.ok) return updated
    return updated.data === null ? missing('Agent run', runId) : { ok: true, data: updated.data }
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
    const started = await adapter.start(request)
    if (!started.ok) return finishFailed(request.runId, started.error)

    const afterStart = deps.runs.getById(request.runId)
    if (!afterStart.ok) return afterStart
    if (afterStart.data !== null && isTerminal(afterStart.data)) {
      return { ok: true, data: afterStart.data }
    }
    const running = deps.runs.update(
      request.runId,
      {
        status: 'running',
        processId: started.data.processId,
        pid: started.data.pid,
        startedAt: started.data.startedAt,
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
    appendEvent(request.runId, 'agent.started', { processId: started.data.processId })
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

  const stopOutput = deps.events.subscribe('process.output', ({ agentRunId, data }) => {
    if (agentRunId === undefined || !activeAdapters.has(agentRunId)) return
    const timestamp = now()
    const updated = deps.runs.update(agentRunId, { lastOutputAt: timestamp }, timestamp)
    if (!updated.ok) {
      logger.error(
        { runId: agentRunId, error: updated.error },
        'Failed to update Agent output time.',
      )
    }
    appendEvent(agentRunId, 'agent.output', { data })
    deps.events.emit('agent.output', { runId: agentRunId, data })
  })

  const stopExited = deps.events.subscribe('process.exited', ({ agentRunId, exitCode, signal }) => {
    if (agentRunId === undefined || !activeAdapters.has(agentRunId)) return
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
    }
    appendEvent(agentRunId, `agent.${status}`, {
      exitCode,
      ...(signal === undefined ? {} : { signal }),
      ...(error === undefined ? {} : { error }),
    })
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
      const runId = createRunId()
      const runDirectory = deps.paths.runDir(runId)
      if (!runDirectory.ok) return runDirectory
      const timestamp = now()
      const created = deps.runs.create(
        {
          id: runId,
          workspaceId: workspace.data.id,
          agentType: definition.id,
          executionMode,
          runDir: runDirectory.data,
          status: shouldQueue ? 'queued' : 'preparing',
          role: request.role ?? definition.defaults.role,
          approvalMode,
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
          ...(request.worktreeId === undefined ? {} : { worktreeId: request.worktreeId }),
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        },
        timestamp,
      )
      if (!created.ok) return created
      appendEvent(runId, 'agent.created', { agentType: definition.id, executionMode })
      deps.events.emit('agent.created', { runId })

      const pending: PendingRun = {
        adapter,
        request: {
          runId,
          workspace: workspace.data,
          ...(task === undefined ? {} : { task }),
          mode,
          approvalMode,
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
          ...(worktreePath === undefined ? {} : { worktreePath }),
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
      const sent = await adapter.send(runId, data)
      if (!sent.ok) return sent
      const timestamp = now()
      const updated = deps.runs.update(runId, { lastInputAt: timestamp }, timestamp)
      if (!updated.ok) return updated
      appendEvent(runId, 'agent.input', { data })
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
        const updated = deps.runs.update(runId, { status: 'cancelled', finishedAt }, finishedAt)
        appendEvent(runId, 'agent.cancelled', {})
        deps.events.emit('agent.cancelled', { runId })
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
      const updated = deps.runs.update(runId, { status: 'cancelled', finishedAt }, finishedAt)
      cancelRequested.delete(runId)
      activeAdapters.delete(runId)
      appendEvent(runId, 'agent.cancelled', {})
      deps.events.emit('agent.cancelled', { runId })
      if (!updated.ok) return updated
      return updated.data === null ? missing('Agent run', runId) : { ok: true, data: updated.data }
    },

    get: (runId) => deps.runs.getById(runId),

    list(request = {}) {
      if (request.activeOnly === true) {
        const active = deps.runs.listActive()
        if (!active.ok || request.workspaceId === undefined) return active
        return {
          ok: true,
          data: active.data.filter((run) => run.workspaceId === request.workspaceId),
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
      stopExited()
      activeAdapters.clear()
      pendingRuns.clear()
      cancelRequested.clear()
    },
  }
}
