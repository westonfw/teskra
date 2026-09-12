import { existsSync } from 'node:fs'

import type {
  IpcResult,
  MergePreflightBlocker,
  MergePreflightCheck,
  MergePreflightCheckId,
  MergePreflightResult,
  WorktreeIdRequest,
  Workspace,
} from '@teskra/contracts'

import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { CriteriaRepository } from '../db/repositories/criteria-repository'
import type { ReviewRepository } from '../db/repositories/review-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { Worktree, WorktreeRepository } from '../db/repositories/worktree-repository'
import { type InternalAppError, toPublicError } from '../errors'
import type { CommandResult, CommandRunner } from '../process/command-runner'
import type { WorkspaceRuntime } from '../workspace/runtime'

/**
 * MergePreflightService (TASK-045, teskra-tasks.md; plan §133).
 *
 * Read-only gate that runs before a worktree merge: it never writes to git,
 * the database, or the filesystem, so an interrupted/blocked preflight leaves
 * the scene untouched for the user to inspect.
 *
 * Check semantics (pinned by tests):
 *
 * - `main-clean` / `worktree-clean`: `git status --porcelain` with the same
 *   node_modules exclusions as WorktreeManager.validate(). Dirty blocks.
 * - `branch-exists`: `git show-ref --verify refs/heads/<branch>`.
 * - `base-branch`: the recorded base branch must still exist AND be an
 *   ancestor of the agent branch (`git merge-base --is-ancestor`) — i.e. the
 *   agent branch was forked from (and never rewound off) the expected base.
 *   Skipped when `branch-exists` already failed to avoid a misleading second
 *   blocker for the same root cause.
 * - `no-ongoing-operation`: MERGE_HEAD / REBASE_HEAD / CHERRY_PICK_HEAD must
 *   not resolve inside the worktree (`git rev-parse --verify`).
 * - `worktree-healthy`: the worktree directory exists on the host AND is
 *   still a live git work tree. Pure probe — unlike validate() it never
 *   rewrites `worktrees.state`.
 * - `required-tests`: conditional. Phase E has no test-result data source in
 *   the schema (§139.1), so this is always `skipped`; the integration point
 *   is `checkRequiredTests` below, to be fed by a future test-run record.
 * - `acceptance-criteria`: conditional (TASK-048 lands in Phase F). The set
 *   is resolved from the run's `criteriaSetId`, falling back to the task's
 *   highest-version `confirmed` set. No confirmed set → `skipped` (listed,
 *   never silent). With a confirmed set, every `required` criterion needs a
 *   `pass` row in `criterion_scores` for THIS run; anything else blocks.
 */

const GIT_TIMEOUT_MS = 60_000

/** Same exclusions as WorktreeManager.validate() status probes. */
const STATUS_ARGS = [
  'status',
  '--porcelain',
  '--',
  '.',
  ':(exclude)node_modules',
  ':(exclude)**/node_modules/**',
] as const

/** Ongoing-operation refs probed inside the worktree (TASK-045). */
const ONGOING_OPERATION_REFS = [
  { ref: 'MERGE_HEAD', label: 'merge' },
  { ref: 'REBASE_HEAD', label: 'rebase' },
  { ref: 'CHERRY_PICK_HEAD', label: 'cherry-pick' },
] as const

export interface MergePreflightService {
  check(request: WorktreeIdRequest): Promise<IpcResult<MergePreflightResult>>
}

export interface MergePreflightServiceDeps {
  readonly commands: CommandRunner
  readonly workspaces: WorkspaceRepository
  readonly worktrees: WorktreeRepository
  readonly runs: AgentRunRepository
  readonly criteria: CriteriaRepository
  readonly reviews: ReviewRepository
  readonly resolveRuntime: (workspace: Workspace) => IpcResult<WorkspaceRuntime>
  /** Filesystem probe; defaults to node:fs existsSync (host-side paths). */
  readonly pathExists?: (path: string) => boolean
}

interface PreflightContext {
  readonly runtime: WorkspaceRuntime
  /** Main repository cwd, runtime-side form. */
  readonly repoCwd: string
  /** Worktree cwd, runtime-side form. */
  readonly worktreeCwd: string
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function commandFailed<T>(operation: string, result: CommandResult): IpcResult<T> {
  return fail({
    code: 'UNKNOWN',
    message: `Git ${operation} failed.`,
    retryable: true,
    detail: `exit=${String(result.exitCode)} stderr=${result.stderr.trim()} stdout=${result.stdout.trim()}`,
  })
}

function passed(id: MergePreflightCheckId, label: string): MergePreflightCheck {
  return { id, label, outcome: 'pass' }
}

function skipped(id: MergePreflightCheckId, label: string, reason: string): MergePreflightCheck {
  return { id, label, outcome: 'skipped', reason }
}

function failed(
  id: MergePreflightCheckId,
  label: string,
  blocker: MergePreflightBlocker,
): MergePreflightCheck {
  return { id, label, outcome: 'failed', blocker }
}

export function createMergePreflightService(
  deps: MergePreflightServiceDeps,
): MergePreflightService {
  const pathExists = deps.pathExists ?? existsSync

  const git = async (
    context: PreflightContext,
    operation: string,
    args: readonly string[],
    cwd: string,
    successExitCodes: readonly number[] = [0],
  ): Promise<IpcResult<CommandResult>> => {
    const result = await deps.commands.run({
      command: 'git',
      args,
      cwd,
      runtime: context.runtime,
      timeoutMs: GIT_TIMEOUT_MS,
    })
    if (!result.ok) return result
    return successExitCodes.includes(result.data.exitCode)
      ? result
      : commandFailed(operation, result.data)
  }

  const checkMainClean = async (
    context: PreflightContext,
  ): Promise<IpcResult<MergePreflightCheck>> => {
    const status = await git(context, 'status', STATUS_ARGS, context.repoCwd)
    if (!status.ok) return status
    return {
      ok: true,
      data:
        status.data.stdout.trim().length === 0
          ? passed('main-clean', 'Main checkout is clean')
          : failed('main-clean', 'Main checkout is clean', {
              code: 'MAIN_WORKSPACE_DIRTY',
              message:
                'The main checkout has uncommitted changes; commit or stash them before merging.',
              overridable: true,
            }),
    }
  }

  const checkWorktreeClean = async (
    context: PreflightContext,
  ): Promise<IpcResult<MergePreflightCheck>> => {
    const status = await git(context, 'status', STATUS_ARGS, context.worktreeCwd, [0, 128])
    if (!status.ok) return status
    if (status.data.exitCode !== 0) {
      return {
        ok: true,
        data: failed('worktree-clean', 'Agent worktree is clean', {
          code: 'WORKTREE_UNAVAILABLE',
          message: 'The agent worktree could not be inspected; see the worktree health check.',
          overridable: false,
        }),
      }
    }
    return {
      ok: true,
      data:
        status.data.stdout.trim().length === 0
          ? passed('worktree-clean', 'Agent worktree is clean')
          : failed('worktree-clean', 'Agent worktree is clean', {
              code: 'WORKTREE_DIRTY',
              message:
                'The agent worktree has uncommitted changes; commit or discard them before merging.',
              overridable: true,
            }),
    }
  }

  const checkBranchExists = async (
    context: PreflightContext,
    worktree: Worktree,
  ): Promise<IpcResult<MergePreflightCheck>> => {
    const ref = await git(
      context,
      'show-ref',
      ['show-ref', '--verify', '--quiet', `refs/heads/${worktree.branch}`],
      context.repoCwd,
      [0, 1],
    )
    if (!ref.ok) return ref
    return {
      ok: true,
      data:
        ref.data.exitCode === 0
          ? passed('branch-exists', 'Agent branch exists')
          : failed('branch-exists', 'Agent branch exists', {
              code: 'BRANCH_MISSING',
              message: `Branch "${worktree.branch}" does not exist; there is nothing to merge.`,
              overridable: false,
            }),
    }
  }

  const checkBaseBranch = async (
    context: PreflightContext,
    worktree: Worktree,
    branchExists: MergePreflightCheck,
  ): Promise<IpcResult<MergePreflightCheck>> => {
    const label = 'Base branch is the expected one'
    if (branchExists.outcome !== 'pass') {
      return { ok: true, data: skipped('base-branch', label, 'The agent branch is missing.') }
    }
    const baseRef = await git(
      context,
      'show-ref',
      ['show-ref', '--verify', '--quiet', `refs/heads/${worktree.baseBranch}`],
      context.repoCwd,
      [0, 1],
    )
    if (!baseRef.ok) return baseRef
    if (baseRef.data.exitCode !== 0) {
      return {
        ok: true,
        data: failed('base-branch', label, {
          code: 'BASE_BRANCH_MISSING',
          message: `The recorded base branch "${worktree.baseBranch}" no longer exists.`,
          overridable: false,
        }),
      }
    }
    const ancestor = await git(
      context,
      'merge-base',
      ['merge-base', '--is-ancestor', worktree.baseBranch, worktree.branch],
      context.repoCwd,
      [0, 1],
    )
    if (!ancestor.ok) return ancestor
    return {
      ok: true,
      data:
        ancestor.data.exitCode === 0
          ? passed('base-branch', label)
          : failed('base-branch', label, {
              code: 'BASE_BRANCH_MISMATCH',
              message: `Branch "${worktree.branch}" is not based on "${worktree.baseBranch}" (the base is not an ancestor); the base may have moved or the branch was rebased.`,
              overridable: true,
            }),
    }
  }

  const checkNoOngoingOperation = async (
    context: PreflightContext,
  ): Promise<IpcResult<MergePreflightCheck>> => {
    const label = 'No ongoing merge / rebase / cherry-pick'
    for (const { ref, label: operation } of ONGOING_OPERATION_REFS) {
      const resolved = await git(
        context,
        'rev-parse',
        ['rev-parse', '--verify', '--quiet', ref],
        context.worktreeCwd,
        [0, 1],
      )
      if (!resolved.ok) return resolved
      if (resolved.data.exitCode === 0) {
        return {
          ok: true,
          data: failed('no-ongoing-operation', label, {
            code: 'ONGOING_OPERATION',
            message: `The agent worktree has an unfinished ${operation} (${ref} exists); finish or abort it before merging.`,
            overridable: false,
          }),
        }
      }
    }
    return { ok: true, data: passed('no-ongoing-operation', label) }
  }

  const checkWorktreeHealthy = async (
    context: PreflightContext,
  ): Promise<IpcResult<MergePreflightCheck>> => {
    const label = 'Worktree is healthy'
    const unhealthy = (detail: string): MergePreflightCheck =>
      failed('worktree-healthy', label, {
        code: 'WORKTREE_UNHEALTHY',
        message: `The agent worktree is not usable: ${detail}.`,
        overridable: false,
      })
    const hostPath = context.runtime.resolveHostPath(context.worktreeCwd)
    if (!hostPath.ok) return hostPath
    if (!pathExists(hostPath.data)) {
      return { ok: true, data: unhealthy('its directory is missing') }
    }
    const inside = await git(
      context,
      'rev-parse',
      ['rev-parse', '--is-inside-work-tree'],
      context.worktreeCwd,
      [0, 128],
    )
    if (!inside.ok) return inside
    if (inside.data.exitCode !== 0 || inside.data.stdout.trim() !== 'true') {
      return { ok: true, data: unhealthy('it is no longer a git work tree') }
    }
    return { ok: true, data: passed('worktree-healthy', label) }
  }

  /**
   * Phase E: always skipped — §139.1 has no test-result table yet. Wire the
   * future test-run record store here when it lands (do NOT invent one in
   * this service).
   */
  const checkRequiredTests = (): MergePreflightCheck =>
    skipped('required-tests', 'Required tests passed', 'No test results are recorded for this run.')

  const checkAcceptanceCriteria = (worktree: Worktree): IpcResult<MergePreflightCheck> => {
    const label = 'Acceptance criteria passed'
    if (worktree.runId === undefined) {
      return {
        ok: true,
        data: skipped('acceptance-criteria', label, 'The worktree is not linked to an agent run.'),
      }
    }
    const run = deps.runs.getById(worktree.runId)
    if (!run.ok) return run
    if (run.data === null) {
      return {
        ok: true,
        data: skipped('acceptance-criteria', label, `Agent run "${worktree.runId}" was not found.`),
      }
    }

    // Prefer the set the run was validated against; otherwise fall back to
    // the task's highest-version confirmed set. Draft/superseded sets and
    // taskless runs mean "no confirmed criteria" → skipped, not pass.
    let criteriaSetId: string | undefined
    if (run.data.criteriaSetId !== undefined) {
      const set = deps.criteria.getSetById(run.data.criteriaSetId)
      if (!set.ok) return set
      if (set.data?.status === 'confirmed') criteriaSetId = set.data.id
    } else if (run.data.taskId !== undefined) {
      const sets = deps.criteria.listSetsByTask(run.data.taskId)
      if (!sets.ok) return sets
      criteriaSetId = sets.data.find((candidate) => candidate.status === 'confirmed')?.id
    }
    if (criteriaSetId === undefined) {
      return {
        ok: true,
        data: skipped('acceptance-criteria', label, 'No confirmed acceptance criteria set.'),
      }
    }

    const criteria = deps.criteria.listCriteria(criteriaSetId)
    if (!criteria.ok) return criteria
    const scores = deps.reviews.listScoresByRun(run.data.id)
    if (!scores.ok) return scores
    const passedCriteria = new Set(
      scores.data.filter((score) => score.result === 'pass').map((score) => score.criterionId),
    )
    const unmet = criteria.data.filter(
      (criterion) => criterion.required && !passedCriteria.has(criterion.id),
    )
    return {
      ok: true,
      data:
        unmet.length === 0
          ? passed('acceptance-criteria', label)
          : failed('acceptance-criteria', label, {
              code: 'CRITERIA_UNMET',
              message: `${String(unmet.length)} required acceptance criteria have not passed: ${unmet
                .map((criterion) => `#${String(criterion.ordinal)} ${criterion.description}`)
                .join('; ')}.`,
              overridable: true,
            }),
    }
  }

  return {
    async check({ worktreeId }) {
      const found = deps.worktrees.getById(worktreeId)
      if (!found.ok) return found
      if (found.data === null) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Worktree "${worktreeId}" was not found.`,
          messageKey: 'errorMessage.worktreeNotFound',
          params: { id: worktreeId },
          retryable: false,
          detail: `MergePreflightService could not resolve worktree id=${JSON.stringify(worktreeId)}`,
        })
      }
      const worktree = found.data

      const workspace = deps.workspaces.getById(worktree.workspaceId)
      if (!workspace.ok) return workspace
      if (workspace.data === null) {
        return fail({
          code: 'WORKSPACE_NOT_FOUND',
          message: `Workspace "${worktree.workspaceId}" was not found.`,
          messageKey: 'errorMessage.workspaceNotFound',
          params: { id: worktree.workspaceId },
          retryable: false,
          detail: `MergePreflightService could not resolve workspace id=${JSON.stringify(worktree.workspaceId)}`,
        })
      }
      const runtime = deps.resolveRuntime(workspace.data)
      if (!runtime.ok) return runtime
      const validated = runtime.data.validate()
      if (!validated.ok) return validated
      const context: PreflightContext = {
        runtime: runtime.data,
        repoCwd: runtime.data.resolveCwd(workspace.data.gitRoot ?? workspace.data.path),
        worktreeCwd: runtime.data.resolveCwd(worktree.path),
      }

      const checks: MergePreflightCheck[] = []
      const collect = async (
        probe: Promise<IpcResult<MergePreflightCheck>>,
      ): Promise<IpcResult<MergePreflightCheck>> => {
        const result = await probe
        if (result.ok) checks.push(result.data)
        return result
      }

      const mainClean = await collect(checkMainClean(context))
      if (!mainClean.ok) return mainClean
      const worktreeClean = await collect(checkWorktreeClean(context))
      if (!worktreeClean.ok) return worktreeClean
      const branchExists = await collect(checkBranchExists(context, worktree))
      if (!branchExists.ok) return branchExists
      const baseBranch = await collect(checkBaseBranch(context, worktree, branchExists.data))
      if (!baseBranch.ok) return baseBranch
      const noOngoing = await collect(checkNoOngoingOperation(context))
      if (!noOngoing.ok) return noOngoing
      const healthy = await collect(checkWorktreeHealthy(context))
      if (!healthy.ok) return healthy
      checks.push(checkRequiredTests())
      const criteria = await collect(Promise.resolve(checkAcceptanceCriteria(worktree)))
      if (!criteria.ok) return criteria

      return {
        ok: true,
        data: {
          worktreeId,
          status: checks.some((check) => check.outcome === 'failed') ? 'blocked' : 'pass',
          checks,
        },
      }
    },
  }
}
