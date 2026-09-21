import { randomUUID } from 'node:crypto'

import {
  DEFAULT_ITERATION_POLICY,
  type DiffFile,
  type DiffFileStatus,
  type DiffPatchResult,
  type FullWorkflowRunSummary,
  type FullWorkflowStartResult,
  type IpcResult,
  type IterationPolicy,
  type StartFullWorkflowRequest,
  type WorkflowIterateResult,
  type Worktree,
} from '@teskra/contracts'
import { computeCriteriaReviewOutcome } from '@teskra/shared'

import type { AgentRegistry } from '../agents/agent-registry'
import type { ProfileAliasManager } from '../agents/profile-alias-manager'
import type { CriteriaRepository } from '../db/repositories/criteria-repository'
import type { ReviewRepository } from '../db/repositories/review-repository'
import type { TaskRepository } from '../db/repositories/task-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { WorktreeRepository } from '../db/repositories/worktree-repository'
import { type InternalAppError, toPublicError } from '../errors'
import type { GitManager } from '../git/git-manager'
import type { WorktreeManager } from '../git/worktree-manager'
import { getLogger } from '../logger'
import { repoLocalContentAllowed } from '../workspace/trust'
import { latestCriterionScores } from './criteria-gate-step-executor'
import {
  buildDefaultFullWorkflowDefinition,
  DEFAULT_FULL_TEST_COMMAND,
  DEFAULT_FULL_WORKFLOW_ID,
  extractFullWorkflowConfig,
  resolveDefaultFullWorkflowConfig,
  type FullWorkflowConfig,
  type FullWorkflowNodeProfiles,
} from './default-workflow'
import type { WorkflowDefinitionLoader } from './definition-loader'
import type { IterationController } from './iteration-controller'
import { prevalidateWorkflowAgentNodeProfiles } from './workflow-engine'
import type { WorkflowRunStore } from './workflow-run-store'

/**
 * FullWorkflowService (TASK-063, teskra-tasks.md) — the default Full Workflow,
 * one click from the Task page:
 *
 *   Acceptance Criteria → Create Worktree → Codex Implement → Build/Test
 *   → Claude Review → Criteria Gate ─ PASS → User Review (the UI summary)
 *                                   └ FAIL → Codex Fix → Test → Review
 *
 * The service deliberately composes existing primitives instead of
 * re-implementing them:
 *
 * - The worktree is created up-front (dispatch semantics, ADR-0002: an
 *   orchestrated run without a worktree must be refused), bound to the FIRST
 *   round's pre-allocated AgentRun id so the branch name and the run record
 *   line up (`agent/<taskId>/<agentId>/<runId>`, ADR-0003).
 * - The 8-node definition snapshot (default-workflow.ts) is persisted on the
 *   run, then a fresh IterationController (TASK-062) drives the loop — the
 *   FAIL → Fix cycle is its multi-round iteration, and the plan §124 safety
 *   caps (maxRoundsPerCriteriaVersion=3 / maxTotalRounds=8) are what stops an
 *   always-failing run: needs_user_review, never an infinite loop.
 * - Agent ids are never hardcoded: per-request override → repo-local
 *   `<repo>/.teskra/workflows/full.*` definition (ADR-0005) → the
 *   AgentRegistry's declared default roles. No candidates = a clear error.
 *   The repo definition loads for every trusted-workspace start (even when
 *   the request names both agents) so its profile aliases / env / test
 *   command merge in — only the agent identities yield to the request.
 *
 * Failure hygiene mirrors DispatchService: anything failing between worktree
 * creation and run persistence discards the fresh worktree (best-effort), so
 * no orphan worktree is left behind.
 */

export interface FullWorkflowService {
  /**
   * Settles only when the loop ends — pass verdict, a triggered cap, or
   * cancellation — so the returned promise can take as long as the agents
   * involved. A failed round is NOT an IPC error; it advances the loop or
   * triggers a cap.
   */
  start(request: StartFullWorkflowRequest): Promise<IpcResult<FullWorkflowStartResult>>
  /** On-demand completion view: steps, worktree, branch diff, criteria result. */
  summary(request: { runId: string }): Promise<IpcResult<FullWorkflowRunSummary>>
  /**
   * Shutdown (P2-1): disposes every controller created for an in-flight
   * start() (cancelling its loop's WorkflowRun) and waits for the starts to
   * settle, so their trailing DB writes never land on an already-closed
   * database.
   */
  dispose(): Promise<void>
}

export interface FullWorkflowServiceDeps {
  readonly runs: WorkflowRunStore
  readonly tasks: Pick<TaskRepository, 'getById'>
  readonly workspaces: Pick<WorkspaceRepository, 'getById'>
  readonly criteria: Pick<CriteriaRepository, 'listSetsByTask' | 'listCriteria'>
  readonly reviews: Pick<ReviewRepository, 'listScoresByTask'>
  readonly worktrees: Pick<WorktreeRepository, 'getByRunId'>
  readonly registry: Pick<AgentRegistry, 'get' | 'list'>
  readonly worktreeManager: Pick<WorktreeManager, 'create' | 'discard'>
  readonly definitions: Pick<WorkflowDefinitionLoader, 'list'>
  readonly git: Pick<GitManager, 'diffRefs'>
  /**
   * Builds the TASK-062 controller bound to the full-workflow engine (shell /
   * review-panel / criteria-gate executors) whose FIRST pre-allocated agent
   * run id is the given one — the id the worktree was created for.
   */
  readonly createController: (firstAgentRunId: string) => IterationController
  readonly createAgentRunId?: () => string
  /**
   * Code-review P2-11: when wired, the repo override's agent-node aliases are
   * validated BEFORE the worktree side effect — an unbound alias fails the
   * start immediately instead of after resources were created. The engine
   * repeats the same check at pass start, so this is the early exit, not the
   * only line of defense.
   */
  readonly profileAliases?: Pick<ProfileAliasManager, 'resolveAgentNodeProfiles'>
}

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

function lineStats(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions }
}

/** Splits a unified multi-file patch into DiffPatchResult files (workflow summary shape). */
export function parseDiffPatch(patch: string): DiffPatchResult {
  const files: DiffFile[] = []
  for (const chunk of patch.split(/^diff --git /mu).slice(1)) {
    const header = chunk.split('\n', 1)[0] ?? ''
    const match = /^a\/(\S+) b\/(\S+)$/u.exec(header.trim())
    if (match === null) continue
    const path = match[2] as string
    let status: DiffFileStatus = 'modified'
    if (chunk.includes('\nnew file mode')) status = 'added'
    else if (chunk.includes('\ndeleted file mode')) status = 'deleted'
    else if (chunk.includes('\nrename from')) status = 'renamed'
    files.push({ path, status, ...lineStats(chunk), patch: `diff --git ${chunk}` })
  }
  return { files }
}

export function createFullWorkflowService(deps: FullWorkflowServiceDeps): FullWorkflowService {
  const logger = getLogger('runtime')
  const createAgentRunId = deps.createAgentRunId ?? randomUUID
  /** Controllers driving in-flight start() calls, for dispose() (P2-1). */
  const activeControllers = new Set<IterationController>()
  /** In-flight start() promises, so dispose() can wait them out (P2-1). */
  const inFlightStarts = new Set<Promise<IpcResult<FullWorkflowStartResult>>>()
  /**
   * Set synchronously by dispose() before the controller snapshot. A start()
   * still in preparation (parked in worktree creation, not yet holding a
   * controller) observes it and aborts before the WorkflowRun exists — so the
   * set dispose() cancels and the set dispose() waits on can never diverge
   * into a before-quit stall.
   */
  let disposing = false

  /**
   * Config precedence: explicit request override → repo-local `full`
   * definition (ADR-0005) → AgentRegistry default roles. Returns undefined
   * fields so the caller can merge per-field.
   */
  const resolveConfig = (repoRoot: string): IpcResult<FullWorkflowConfig | undefined> => {
    const listed = deps.definitions.list(repoRoot)
    if (!listed.ok) return listed
    const override = listed.data.find((info) => info.id === DEFAULT_FULL_WORKFLOW_ID)
    if (override === undefined) return { ok: true, data: undefined }
    if (override.status === 'invalid' || override.definition === undefined) {
      return invalid(
        `Workflow definition "${DEFAULT_FULL_WORKFLOW_ID}" is invalid and cannot drive the default full workflow.`,
        `${override.path}: ${override.issues.join('; ')}`,
      )
    }
    return extractFullWorkflowConfig(override.definition)
  }

  const executeStart = async (
    request: StartFullWorkflowRequest,
  ): Promise<IpcResult<FullWorkflowStartResult>> => {
    const task = deps.tasks.getById(request.taskId)
    if (!task.ok) return task
    if (task.data === null) {
      return invalid(
        `Task "${request.taskId}" was not found.`,
        `FullWorkflowService could not resolve task id=${JSON.stringify(request.taskId)}`,
      )
    }
    if (task.data.workspaceId !== request.workspaceId) {
      return invalid(
        'The task belongs to a different workspace.',
        `task workspace=${task.data.workspaceId} full-workflow workspace=${request.workspaceId}`,
      )
    }
    const workspace = deps.workspaces.getById(request.workspaceId)
    if (!workspace.ok) return workspace
    if (workspace.data === null) {
      return invalid(
        `Workspace "${request.workspaceId}" was not found.`,
        `FullWorkflowService could not resolve workspace id=${JSON.stringify(request.workspaceId)}`,
      )
    }

    // Step 1 of the default flow: Acceptance Criteria — the loop anchors to
    // the task's confirmed set, so one must exist before launch.
    const sets = deps.criteria.listSetsByTask(request.taskId)
    if (!sets.ok) return sets
    const confirmed = sets.data
      .filter((set) => set.status === 'confirmed')
      .sort((a, b) => b.version - a.version)[0]
    if (confirmed === undefined) {
      return invalid(
        'The default full workflow requires a confirmed acceptance criteria set; confirm one first.',
        `task id=${JSON.stringify(request.taskId)} has no confirmed criteria set`,
      )
    }

    const merged: {
      implementer?: string | undefined
      reviewers?: readonly string[] | undefined
      testCommand?: string | undefined
      implementerProfiles?: FullWorkflowNodeProfiles | undefined
      fixerProfiles?: FullWorkflowNodeProfiles | undefined
    } = {
      ...(request.implementer === undefined ? {} : { implementer: request.implementer }),
      ...(request.reviewers === undefined ? {} : { reviewers: request.reviewers }),
      ...(request.testCommand === undefined ? {} : { testCommand: request.testCommand }),
    }
    // TASK-118: the repo-local `full.*` override is repo-controlled content —
    // it only loads for trusted workspaces (code-review P0-3). A test command
    // taken from it is a repo-defined shell command, so the Build/Test steps
    // get requireConfirmation: the user sees the full command line first.
    //
    // The override loads whenever the workspace is trusted — NOT only when
    // the request left the agent identities open. Explicit identities from
    // the launch dialog still win (`??=` below), but the override's profiles
    // (TASK-111 aliases / env) and test command merge in either way; gating
    // the load on missing identities silently dropped `accountProfile`
    // whenever the user picked both agents explicitly — the same silent
    // default-account fallback P0-2 removed.
    let testCommandFromRepo = false
    if (repoLocalContentAllowed(workspace.data)) {
      const override = resolveConfig(workspace.data.path)
      if (!override.ok) return override
      if (merged.testCommand === undefined && override.data?.testCommand !== undefined) {
        testCommandFromRepo = true
      }
      merged.implementer ??= override.data?.implementer
      merged.reviewers ??= override.data?.reviewers
      merged.testCommand ??= override.data?.testCommand
      // P0-2: the agent nodes' TASK-111 aliases / env ride along too —
      // dropping them would silently run under the default account.
      merged.implementerProfiles ??= override.data?.implementerProfiles
      merged.fixerProfiles ??= override.data?.fixerProfiles
    } else {
      getLogger('security').warn(
        { workspaceId: request.workspaceId },
        'Workspace is restricted; ignoring the repo-local full workflow definition override.',
      )
    }
    let config: FullWorkflowConfig
    if (merged.implementer !== undefined && merged.reviewers !== undefined) {
      config = {
        implementer: merged.implementer,
        reviewers: merged.reviewers,
        testCommand: merged.testCommand ?? DEFAULT_FULL_TEST_COMMAND,
        ...(testCommandFromRepo ? { shellRequireConfirmation: true } : {}),
        ...(merged.implementerProfiles === undefined
          ? {}
          : { implementerProfiles: merged.implementerProfiles }),
        ...(merged.fixerProfiles === undefined ? {} : { fixerProfiles: merged.fixerProfiles }),
      }
    } else {
      const defaults = resolveDefaultFullWorkflowConfig(deps.registry.list())
      if (!defaults.ok) return defaults
      config = {
        implementer: merged.implementer ?? defaults.data.implementer,
        reviewers: merged.reviewers ?? defaults.data.reviewers,
        testCommand: merged.testCommand ?? defaults.data.testCommand,
        ...(testCommandFromRepo ? { shellRequireConfirmation: true } : {}),
        ...(merged.implementerProfiles === undefined
          ? {}
          : { implementerProfiles: merged.implementerProfiles }),
        ...(merged.fixerProfiles === undefined ? {} : { fixerProfiles: merged.fixerProfiles }),
      }
    }
    for (const agentId of [config.implementer, ...config.reviewers]) {
      if (deps.registry.get(agentId) === undefined) {
        return invalid(
          `Agent "${agentId}" is not registered.`,
          `FullWorkflowService could not resolve agent=${JSON.stringify(agentId)}`,
        )
      }
    }

    const definition = buildDefaultFullWorkflowDefinition(config)
    // P2-11: an unbound alias must fail BEFORE the worktree side effect (and
    // before any earlier DAG node runs). Without a wired resolver the check
    // is deferred to the engine's pass-start backstop, which fails closed.
    if (deps.profileAliases !== undefined) {
      const prevalidated = prevalidateWorkflowAgentNodeProfiles(definition, deps.profileAliases)
      if (!prevalidated.ok) return prevalidated
    }

    const policy: IterationPolicy = {
      maxRoundsPerCriteriaVersion:
        request.policy?.maxRoundsPerCriteriaVersion ??
        DEFAULT_ITERATION_POLICY.maxRoundsPerCriteriaVersion,
      maxTotalRounds: request.policy?.maxTotalRounds ?? DEFAULT_ITERATION_POLICY.maxTotalRounds,
    }
    const firstAgentRunId = createAgentRunId()
    const worktree = await deps.worktreeManager.create({
      workspaceId: request.workspaceId,
      runId: firstAgentRunId,
      taskId: request.taskId,
      agentId: config.implementer,
      ...(request.isolation === undefined ? {} : { isolation: request.isolation }),
    })
    if (!worktree.ok) return worktree

    const discardWorktree = (): void => {
      void deps.worktreeManager
        .discard({ worktreeId: worktree.data.id, confirm: true })
        .catch((cause: unknown) => {
          logger.error({ worktreeId: worktree.data.id, cause }, 'Worktree discard threw.')
        })
    }

    // A dispose() that raced the preparation cannot reach this start through
    // activeControllers (none exists yet); abort before the WorkflowRun is
    // created so dispose()'s wait settles instead of a fresh loop starting
    // underneath it.
    if (disposing) {
      discardWorktree()
      return shuttingDown('FullWorkflowService is disposing; start aborted before run creation.')
    }
    const created = deps.runs.createRun({
      definition,
      taskId: request.taskId,
      totalIterations: policy.maxTotalRounds,
      criteriaSetId: confirmed.id,
    })
    if (!created.ok) {
      discardWorktree()
      return created
    }
    const run = created.data.run

    // The controller drives the loop (TASK-062 caps included); the runId
    // resume path executes the persisted full-workflow snapshot round by
    // round inside the pre-created worktree.
    const controller = deps.createController(firstAgentRunId)
    activeControllers.add(controller)
    let iterated: IpcResult<WorkflowIterateResult>
    try {
      iterated = await controller.iterate({
        workspaceId: request.workspaceId,
        taskId: request.taskId,
        runId: run.id,
        worktreeId: worktree.data.id,
        policy,
        ...(request.model === undefined ? {} : { model: request.model }),
      })
    } finally {
      activeControllers.delete(controller)
    }
    if (!iterated.ok) {
      const failedRun = deps.runs.setRunStatus(run.id, 'failed')
      if (!failedRun.ok) return failedRun
      return iterated
    }

    return {
      ok: true,
      data: {
        run: iterated.data.run,
        worktree: worktree.data,
        rounds: iterated.data.rounds,
        stopReason: iterated.data.stopReason,
      },
    }
  }

  return {
    start(request) {
      const promise = executeStart(request)
      inFlightStarts.add(promise)
      const cleanup = (): void => {
        inFlightStarts.delete(promise)
      }
      void promise.then(cleanup, cleanup)
      return promise
    },

    async summary({ runId }) {
      const detail = deps.runs.getRun(runId)
      if (!detail.ok) return detail
      if (detail.data === null) {
        return invalid(
          `Workflow run "${runId}" was not found.`,
          `FullWorkflowService could not resolve run id=${JSON.stringify(runId)}`,
        )
      }
      const { run, steps } = detail.data

      // The worktree links through the first round's implement AgentRun id
      // (the service pre-allocated it at launch); scan agent steps oldest
      // first so round 1 wins.
      let worktree: Worktree | null = null
      const agentRunIds = steps
        .filter((step) => step.nodeType === 'agent')
        .sort((a, b) => a.iteration - b.iteration || a.createdAt.localeCompare(b.createdAt))
        .map((step) => step.result?.['agentRunId'])
        .filter((id): id is string => typeof id === 'string')
      for (const agentRunId of agentRunIds) {
        const found = deps.worktrees.getByRunId(agentRunId)
        if (!found.ok) return found
        if (found.data !== null) {
          worktree = found.data
          break
        }
      }

      // Diff target: worktree branch vs its base branch (three-dot: only what
      // the branch changed). A missing base (deleted branch) yields no diff —
      // logged, never fatal.
      let diff: DiffPatchResult | null = null
      if (worktree !== null) {
        const patch = await deps.git.diffRefs({
          workspaceId: worktree.workspaceId,
          baseRef: worktree.baseBranch,
          headRef: worktree.branch,
        })
        if (patch.ok) {
          diff = parseDiffPatch(patch.data.patch)
        } else {
          logger.warn(
            { runId, worktreeId: worktree.id, error: patch.error },
            'Could not compute the worktree branch diff for the run summary.',
          )
        }
      }

      let criteria: FullWorkflowRunSummary['criteria'] = []
      let criterionScores: FullWorkflowRunSummary['criterionScores'] = []
      let criteriaOutcome: FullWorkflowRunSummary['criteriaOutcome'] = null
      if (run.criteriaSetId !== undefined) {
        const rows = deps.criteria.listCriteria(run.criteriaSetId)
        if (!rows.ok) return rows
        criteria = rows.data
        if (run.taskId !== undefined) {
          const scores = deps.reviews.listScoresByTask(run.taskId)
          if (!scores.ok) return scores
          const criterionIds = new Set(criteria.map((criterion) => criterion.id))
          criterionScores = scores.data.filter((score) => criterionIds.has(score.criterionId))
          criteriaOutcome =
            criteria.length > 0
              ? computeCriteriaReviewOutcome(criteria, latestCriterionScores(criterionScores))
              : null
        }
      }

      return {
        ok: true,
        data: { run, steps, worktree, diff, criteria, criterionScores, criteriaOutcome },
      }
    },

    async dispose() {
      // Flag first: any start() still short of createController() aborts at
      // its pre-creation check instead of slipping past the cancel snapshot.
      disposing = true
      // Dispose each in-flight controller first (its engine cancel settles
      // the loop promptly), then wait out the trailing finalization writes.
      await Promise.allSettled([...activeControllers].map((controller) => controller.dispose()))
      await Promise.allSettled([...inFlightStarts])
    },
  }
}
