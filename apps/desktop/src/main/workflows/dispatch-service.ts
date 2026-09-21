import { randomUUID } from 'node:crypto'

import type {
  IpcResult,
  WorkflowDispatchRequest,
  WorkflowDispatchResult,
  WorkbenchEvents,
  WorkflowRunStatus,
} from '@teskra/contracts'

import type { AgentManager } from '../agents/agent-manager'
import type { AgentRegistry } from '../agents/agent-registry'
import type { CriteriaRepository } from '../db/repositories/criteria-repository'
import type { HandoffRepository } from '../db/repositories/handoff-repository'
import type { TaskRepository } from '../db/repositories/task-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import type { WorktreeManager } from '../git/worktree-manager'
import { getLogger } from '../logger'
import type { ContextBuilder } from '../memory/context-builder'
import type { TeskraPaths } from '../paths'
import {
  TESKRA_AGENT_PROTOCOL,
  type PromptTemplateService,
} from '../prompts/prompt-template-service'
import { trustedRepoRoot } from '../workspace/trust'
import type { WorkflowEngine } from './workflow-engine'
import type { WorkflowRunStore } from './workflow-run-store'

/**
 * DispatchService (TASK-059, teskra-tasks.md) — the Dispatch Primitive:
 *
 *   Task → One Agent → Handoff
 *
 * Design choice: dispatch REUSES the WorkflowEngine instead of calling
 * AgentManager directly. A single-agent dispatch has no DAG semantics, but
 * routing it through a one-node WorkflowRun keeps one uniform execution
 * record (workflow_runs + workflow_steps rows, workflow.run_updated /
 * workflow.step_updated events) for every orchestrated launch, and TASK-062's
 * Iterate primitive builds on the same records. The cost — one extra
 * definition snapshot row per dispatch — is accepted deliberately.
 *
 * Isolation semantics (ADR-0002 red line): dispatch is ALWAYS orchestrated,
 * and an orchestrated AgentRun without a worktree must be refused — so the
 * worktree is created up-front and is never optional. `request.isolation`
 * only selects the worktree's isolation tier and defaults to 'worktree'
 * (WorktreeManager's own default). There is deliberately no attended
 * dispatch; ad-hoc attended runs stay on AgentManager.start.
 *
 * Flow:
 *
 * 1. Resolve the agent definition (AgentRegistry), task and workspace; the
 *    task must belong to the workspace.
 * 2. Pre-allocate the AgentRun id, then create the worktree bound to it
 *    (branch `agent/<taskId>/<agentId>/<runId>`, ADR-0003 — WorktreeManager
 *    owns the naming).
 * 3. Render the prompt: `request.prompt` wins; otherwise the TASK-079
 *    'implement' template with task / confirmed criteria / ADR-0004 handoff
 *    env paths (derived from the pre-allocated run id so they match the paths
 *    AgentManager injects).
 * 4. Persist a one-node WorkflowRun ('implement' agent node) and execute one
 *    engine pass with { worktreeId, agentRunId, prompt } in the context. The
 *    engine's agent executor launches the run orchestrated inside the
 *    worktree; on terminal exit AgentManager's HandoffCollector persists the
 *    handoff BEFORE emitting the event the engine waits on, so the handoff is
 *    already queryable when the pass settles.
 * 5. The engine leaves the settled run `waiting`; dispatch owns the final
 *    fate (engine convention) and marks it completed / failed / cancelled
 *    from the step outcome.
 *
 * Failure hygiene: if anything between worktree creation and WorkflowRun
 * persistence fails, the fresh worktree is discarded (best-effort) so no
 * orphan worktree is left behind; once the run exists it stays for
 * inspection, matching how AgentManager keeps failed runs.
 */
export interface DispatchService {
  /**
   * Settles only when the dispatched AgentRun reaches a terminal state — the
   * returned promise can take as long as the agent itself. A failed agent run
   * is NOT an IPC error: it returns `ok` with run.status 'failed' (and
   * whatever handoff the collector produced).
   */
  dispatch(request: WorkflowDispatchRequest): Promise<IpcResult<WorkflowDispatchResult>>
  /**
   * Shutdown (P2-1): cancels every in-flight dispatch's WorkflowRun and waits
   * for the dispatches to settle, so their trailing DB writes never land on
   * an already-closed database.
   */
  dispose(): Promise<void>
}

export interface DispatchServiceDeps {
  readonly runs: WorkflowRunStore
  readonly engine: WorkflowEngine
  readonly registry: Pick<AgentRegistry, 'get'>
  readonly tasks: Pick<TaskRepository, 'getById'>
  readonly criteria: Pick<CriteriaRepository, 'listSetsByTask' | 'listCriteria'>
  readonly workspaces: Pick<WorkspaceRepository, 'getById'>
  readonly worktreeManager: Pick<WorktreeManager, 'create' | 'discard'>
  readonly agents: Pick<AgentManager, 'get'>
  readonly handoffs: Pick<HandoffRepository, 'getByRunId'>
  readonly promptTemplates: Pick<PromptTemplateService, 'render'>
  /**
   * TASK-068: packs the Workspace Memory section for the `{{memory}}`
   * template variable under its own budget. Optional so older consumers keep
   * rendering without memory; when present the memory content is part of the
   * final Context the adapter receives.
   */
  readonly contextBuilder?: Pick<ContextBuilder, 'buildContext'>
  readonly paths: TeskraPaths
  readonly events: EventBus<WorkbenchEvents>
  readonly createAgentRunId?: () => string
}

/** Fixed identity of the one-node definition snapshot every dispatch persists. */
const DISPATCH_DEFINITION_ID = 'dispatch'
const DISPATCH_NODE_ID = 'implement'
/**
 * TASK-068: the `{{memory}}` section gets half the standard context budget.
 * TASK-127: the inlined `{{protocol}}` document is charged against the same
 * envelope (subtracted at the buildContext call site).
 */
const DISPATCH_MEMORY_BUDGET_CHARS = 4000

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function invalid<T>(message: string, detail: string): IpcResult<T> {
  return fail({ code: 'VALIDATION_FAILED', message, retryable: false, detail })
}

function shuttingDown<T>(detail: string): IpcResult<T> {
  return fail({
    code: 'UNKNOWN',
    message: 'Teskra is shutting down; the workflow run was not started.',
    retryable: false,
    detail,
  })
}

export function createDispatchService(deps: DispatchServiceDeps): DispatchService {
  const logger = getLogger('runtime')
  const createAgentRunId = deps.createAgentRunId ?? randomUUID
  /** In-flight dispatch() promises, so dispose() can wait them out (P2-1). */
  const inFlight = new Set<Promise<IpcResult<WorkflowDispatchResult>>>()
  /** WorkflowRun ids of in-flight dispatches, for dispose()'s cancel pass. */
  const activeRunIds = new Set<string>()
  /**
   * Set synchronously by dispose() before the cancel snapshot. A dispatch
   * still in preparation (parked in worktree creation, not yet in
   * activeRunIds) observes it and aborts before the WorkflowRun exists — so
   * the set dispose() cancels and the set dispose() waits on can never
   * diverge into a before-quit stall.
   */
  let disposing = false

  const emitRunStatus = (runId: string, status: WorkflowRunStatus): void => {
    deps.events.emit('workflow.run_updated', { runId, status })
  }

  const executeDispatch = async (
    request: WorkflowDispatchRequest,
  ): Promise<IpcResult<WorkflowDispatchResult>> => {
    const agent = deps.registry.get(request.agent)
    if (agent === undefined) {
      return invalid(
        `Agent "${request.agent}" is not registered.`,
        `DispatchService could not resolve agent=${JSON.stringify(request.agent)}`,
      )
    }
    const task = deps.tasks.getById(request.taskId)
    if (!task.ok) return task
    if (task.data === null) {
      return invalid(
        `Task "${request.taskId}" was not found.`,
        `DispatchService could not resolve task id=${JSON.stringify(request.taskId)}`,
      )
    }
    if (task.data.workspaceId !== request.workspaceId) {
      return invalid(
        'The task belongs to a different workspace.',
        `task workspace=${task.data.workspaceId} dispatch workspace=${request.workspaceId}`,
      )
    }
    const workspace = deps.workspaces.getById(request.workspaceId)
    if (!workspace.ok) return workspace
    if (workspace.data === null) {
      return invalid(
        `Workspace "${request.workspaceId}" was not found.`,
        `DispatchService could not resolve workspace id=${JSON.stringify(request.workspaceId)}`,
      )
    }

    const agentRunId = createAgentRunId()
    const worktree = await deps.worktreeManager.create({
      workspaceId: request.workspaceId,
      runId: agentRunId,
      taskId: request.taskId,
      agentId: agent.id,
      ...(request.isolation === undefined ? {} : { isolation: request.isolation }),
    })
    if (!worktree.ok) return worktree

    // Compensating action for failures before the WorkflowRun exists:
    // never leave an orphan worktree behind (ReviewerService pattern).
    const discardWorktree = (): void => {
      void deps.worktreeManager
        .discard({ worktreeId: worktree.data.id, confirm: true })
        .then((discarded) => {
          if (!discarded.ok) {
            logger.error(
              { worktreeId: worktree.data.id, error: discarded.error },
              'Failed to discard the dispatch worktree after a startup failure.',
            )
          }
        })
        .catch((cause: unknown) => {
          logger.error({ worktreeId: worktree.data.id, cause }, 'Dispatch worktree discard threw.')
        })
    }

    const runFiles = deps.paths.runFiles(agentRunId)
    if (!runFiles.ok) {
      discardWorktree()
      return runFiles
    }

    let prompt = request.prompt
    if (prompt === undefined) {
      let criteriaDetails: { id: string; description: string }[] | undefined
      const sets = deps.criteria.listSetsByTask(request.taskId)
      if (!sets.ok) {
        discardWorktree()
        return sets
      }
      const confirmed = sets.data
        .filter((set) => set.status === 'confirmed')
        .sort((a, b) => b.version - a.version)[0]
      if (confirmed !== undefined) {
        const rows = deps.criteria.listCriteria(confirmed.id)
        if (!rows.ok) {
          discardWorktree()
          return rows
        }
        criteriaDetails = rows.data.map((criterion) => ({
          id: criterion.id,
          description: criterion.description,
        }))
      }
      // TASK-068: the {{memory}} variable carries the ContextBuilder-packed
      // Workspace Memory section (budget-limited; empty workspace memory
      // renders as an empty section). TASK-127: the inlined {{protocol}}
      // section is charged against the same dispatch context budget, so
      // ContextBuilder packs memory under what the protocol leaves behind.
      let memory: string | undefined
      if (deps.contextBuilder !== undefined) {
        const built = deps.contextBuilder.buildContext({
          workspaceId: request.workspaceId,
          budgetChars: Math.max(1, DISPATCH_MEMORY_BUDGET_CHARS - TESKRA_AGENT_PROTOCOL.length),
        })
        if (!built.ok) {
          discardWorktree()
          return built
        }
        if (built.data.content.length > 0) {
          memory = built.data.content
        }
      }
      // TASK-118: repo-local prompt overrides load only for trusted
      // workspaces (code-review P0-3); restricted ones render the built-ins.
      const promptRepoRoot = trustedRepoRoot(workspace.data)
      if (promptRepoRoot === undefined) {
        logger.warn(
          { workspaceId: request.workspaceId },
          'Workspace is restricted; repo-local prompt templates are not loaded.',
        )
      }
      const rendered = deps.promptTemplates.render(
        {
          name: 'implement',
          context: {
            task: {
              title: task.data.title,
              description: task.data.description ?? '',
            },
            ...(criteriaDetails === undefined ? {} : { criteriaDetails }),
            ...(memory === undefined ? {} : { memory }),
            role: 'implementer',
            env: {
              TESKRA_HANDOFF_PATH: runFiles.data.handoff,
              TESKRA_ARTIFACT_DIR: runFiles.data.artifacts,
              TESKRA_PROGRESS_PATH: runFiles.data.progress,
            },
          },
        },
        promptRepoRoot,
      )
      if (!rendered.ok) {
        discardWorktree()
        return rendered
      }
      prompt = rendered.data.content
    }

    // A dispose() that raced the preparation cannot cancel this dispatch via
    // activeRunIds (nothing to cancel yet); abort before the WorkflowRun
    // exists so dispose()'s wait settles instead of a fresh engine pass
    // starting underneath it.
    if (disposing) {
      discardWorktree()
      return shuttingDown('DispatchService is disposing; dispatch aborted before run creation.')
    }
    const created = deps.runs.createRun({
      definition: {
        id: DISPATCH_DEFINITION_ID,
        description: 'TASK-059 single-agent dispatch (Task → One Agent → Handoff).',
        steps: [
          {
            id: DISPATCH_NODE_ID,
            type: 'agent',
            agent: agent.id,
            role: 'implementer',
            isolation: worktree.data.isolation,
            runOn: 'always',
          },
        ],
      },
      taskId: request.taskId,
      totalIterations: 1,
    })
    if (!created.ok) {
      discardWorktree()
      return created
    }
    const run = created.data.run
    activeRunIds.add(run.id)
    try {
      const settled = await deps.engine.start(run.id, {
        workspaceId: request.workspaceId,
        worktreeId: worktree.data.id,
        agentRunId,
        prompt,
        ...(request.model === undefined ? {} : { model: request.model }),
      })
      if (!settled.ok) {
        const failedRun = deps.runs.setRunStatus(run.id, 'failed')
        if (failedRun.ok) emitRunStatus(run.id, 'failed')
        return settled
      }

      const step = settled.data.steps.find(
        (entry) => entry.nodeId === DISPATCH_NODE_ID && entry.iteration === run.currentIteration,
      )
      // A cancelled agent settles its step 'failed' with result.cancelled
      // (the engine's outcome model has no cancel outcome) — do not report
      // a user cancellation as a failure.
      const finalStatus: WorkflowRunStatus =
        step?.status === 'completed'
          ? 'completed'
          : step?.status === 'cancelled' || step?.result?.['cancelled'] === true
            ? 'cancelled'
            : 'failed'
      const finalized = deps.runs.setRunStatus(run.id, finalStatus)
      if (!finalized.ok) return finalized
      emitRunStatus(run.id, finalStatus)

      const agentRun = deps.agents.get(agentRunId)
      if (!agentRun.ok) return agentRun
      if (agentRun.data === null) {
        return invalid(
          `Agent run "${agentRunId}" was not found after the dispatch settled.`,
          `DispatchService lost agent run id=${agentRunId} for workflow run ${run.id}`,
        )
      }
      const handoff = deps.handoffs.getByRunId(agentRunId)
      if (!handoff.ok) return handoff

      return {
        ok: true,
        data: {
          run: finalized.data,
          agentRun: agentRun.data,
          worktree: worktree.data,
          handoffPath: runFiles.data.handoff,
          handoff: handoff.data,
        },
      }
    } finally {
      activeRunIds.delete(run.id)
    }
  }

  return {
    dispatch(request) {
      const promise = executeDispatch(request)
      inFlight.add(promise)
      const cleanup = (): void => {
        inFlight.delete(promise)
      }
      void promise.then(cleanup, cleanup)
      return promise
    },

    async dispose() {
      // Flag first: any dispatch still short of activeRunIds.add() aborts at
      // its pre-creation check instead of slipping past the cancel snapshot.
      disposing = true
      // Cancel first so a dispatch parked in engine.start settles promptly,
      // then wait out the trailing finalization writes.
      await Promise.allSettled([...activeRunIds].map((runId) => deps.engine.cancel(runId)))
      await Promise.allSettled([...inFlight])
    },
  }
}
