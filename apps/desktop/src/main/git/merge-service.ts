import type {
  DecisionOption,
  IpcResult,
  MergePreflightBlocker,
  WorkbenchEvents,
  WorktreeMergeRequest,
  WorktreeMergeResult,
  Workspace,
} from '@teskra/contracts'

import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { TaskRepository } from '../db/repositories/task-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { Worktree, WorktreeRepository } from '../db/repositories/worktree-repository'
import type { DecisionService } from '../decisions/decision-service'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { CommandResult, CommandRunner } from '../process/command-runner'
import type { WorkspaceRuntime } from '../workspace/runtime'
import type { MergePreflightService } from './merge-preflight-service'

/**
 * MergeService (TASK-046, teskra-tasks.md; plan §132/§133).
 *
 * Executes a worktree merge after the TASK-045 preflight gate, and — this is
 * the point of the task — PRESERVES the scene when the merge conflicts: the
 * worktree, the agent branch, and the in-progress merge (MERGE_HEAD +
 * conflict markers) are all left in place so the user can resolve by hand.
 * Nothing here ever runs `git merge --abort`, removes a worktree, or deletes
 * a branch.
 *
 * Execution semantics (the trade-off, pinned by tests):
 *
 * - The 3-way merge runs INSIDE the agent worktree as
 *   `git merge <baseBranch>` (integrating the base into the agent branch),
 *   never in the main checkout. The main checkout may be dirty, on another
 *   branch, or simply in use — a conflict scene there would be far more
 *   disruptive than inside the worktree, which TASK-046 already keeps.
 * - On success the base branch is fast-forwarded to the agent branch (the
 *   in-worktree merge guarantees base is an ancestor of the agent HEAD, so
 *   the advance is always a fast-forward):
 *   - if the main checkout currently has the base branch checked out, via
 *     `git merge --ff-only` there (safe: preflight verified it clean);
 *   - otherwise via `git fetch . <agent>:<base>`, which refuses non-ff
 *     updates and refuses to touch a branch checked out anywhere else.
 * - On conflict the merge state stays inside the worktree (MERGE_HEAD), the
 *   worktree record goes to 'conflict', the linked Run is marked via
 *   `error_json` (`MERGE_CONFLICT` — AgentRunStatus has no conflict value and
 *   §139.1 is the schema authority), and the linked Task goes to
 *   'needs_review'. Resolving means: open a terminal in the worktree, fix,
 *   commit — then re-run merge, which completes the fast-forward.
 *
 * Preflight gate: any failed check with `overridable: false` always blocks;
 * overridable blockers require `force: true`. A blocked merge changes nothing
 * in git or the database.
 *
 * TASK-130 (ADR-0014 §3, design §9.2): a merge blocked by ONLY overridable
 * blockers additionally opens a persisted `merge_blocked` PendingDecision
 * (force_merge / cancel) — the caller still receives MERGE_BLOCKED, so the
 * existing IPC/UI path is unchanged; resolving `force_merge` re-enters
 * `merge({ force: true })` from the onResolved subscription. Hard blockers
 * never open a decision.
 */

const GIT_TIMEOUT_MS = 60_000

/** §9.2 vocabulary; force_merge is the danger option (the UI confirms twice). */
const MERGE_BLOCKED_OPTIONS: readonly DecisionOption[] = [
  { id: 'force_merge', label: 'Force merge', danger: true },
  { id: 'cancel', label: 'Cancel' },
]

export interface MergeService {
  merge(request: WorktreeMergeRequest): Promise<IpcResult<WorktreeMergeResult>>
}

export interface MergeServiceDeps {
  readonly commands: CommandRunner
  readonly workspaces: WorkspaceRepository
  readonly worktrees: WorktreeRepository
  readonly runs: AgentRunRepository
  readonly tasks: TaskRepository
  readonly events: EventBus<WorkbenchEvents>
  readonly preflight: MergePreflightService
  readonly resolveRuntime: (workspace: Workspace) => IpcResult<WorkspaceRuntime>
  /**
   * TASK-130 (ADR-0014): with a DecisionService composed, an overridable-only
   * blocked merge opens a `merge_blocked` decision and its `force_merge`
   * resolution re-runs the merge with force. Without it a blocked merge only
   * returns MERGE_BLOCKED (TASK-046 behavior).
   */
  readonly decisions?: Pick<DecisionService, 'open' | 'onResolved'>
  readonly now?: () => string
}

interface MergeContext {
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

export function createMergeService(deps: MergeServiceDeps): MergeService {
  const logger = getLogger('runtime')
  const now = deps.now ?? (() => new Date().toISOString())

  const git = async (
    context: MergeContext,
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

  const contextFor = (worktree: Worktree): IpcResult<MergeContext> => {
    const workspace = deps.workspaces.getById(worktree.workspaceId)
    if (!workspace.ok) return workspace
    if (workspace.data === null) {
      return fail({
        code: 'WORKSPACE_NOT_FOUND',
        message: `Workspace "${worktree.workspaceId}" was not found.`,
        messageKey: 'errorMessage.workspaceNotFound',
        params: { id: worktree.workspaceId },
        retryable: false,
        detail: `MergeService could not resolve workspace id=${JSON.stringify(worktree.workspaceId)}`,
      })
    }
    const runtime = deps.resolveRuntime(workspace.data)
    if (!runtime.ok) return runtime
    const validated = runtime.data.validate()
    if (!validated.ok) return validated
    return {
      ok: true,
      data: {
        runtime: runtime.data,
        repoCwd: runtime.data.resolveCwd(workspace.data.gitRoot ?? workspace.data.path),
        worktreeCwd: runtime.data.resolveCwd(worktree.path),
      },
    }
  }

  /** Fast-forward the base branch to the agent branch; never a 3-way merge. */
  const advanceBase = async (
    context: MergeContext,
    worktree: Worktree,
  ): Promise<IpcResult<void>> => {
    const current = await git(context, 'branch', ['branch', '--show-current'], context.repoCwd)
    if (!current.ok) return current
    if (current.data.stdout.trim() === worktree.baseBranch) {
      const fastForward = await git(
        context,
        'merge',
        ['merge', '--ff-only', worktree.branch],
        context.repoCwd,
      )
      if (!fastForward.ok) return fastForward
      return { ok: true, data: undefined }
    }
    const fetched = await git(
      context,
      'fetch',
      ['fetch', '.', `${worktree.branch}:${worktree.baseBranch}`],
      context.repoCwd,
    )
    if (!fetched.ok) return fetched
    return { ok: true, data: undefined }
  }

  /** Marks the linked Run (error_json) and Task (needs_review); never throws. */
  const markConflict = (worktree: Worktree, conflicts: readonly string[]): void => {
    if (worktree.runId === undefined) return
    const run = deps.runs.getById(worktree.runId)
    if (!run.ok || run.data === null) return
    const marked = deps.runs.update(run.data.id, {
      error: {
        code: 'MERGE_CONFLICT',
        message: `Merging "${worktree.branch}" into "${worktree.baseBranch}" conflicts in ${String(conflicts.length)} file(s); the worktree was preserved for manual resolution.`,
      },
    })
    if (!marked.ok || marked.data === null) return
    if (run.data.taskId === undefined) return
    const task = deps.tasks.updateStatus(run.data.taskId, 'needs_review', now())
    if (task.ok && task.data !== null) {
      deps.events.emit('task.updated', { taskId: run.data.taskId })
    }
  }

  const service: MergeService = {
    async merge({ worktreeId, force }) {
      const found = deps.worktrees.getById(worktreeId)
      if (!found.ok) return found
      if (found.data === null) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Worktree "${worktreeId}" was not found.`,
          messageKey: 'errorMessage.worktreeNotFound',
          params: { id: worktreeId },
          retryable: false,
          detail: `MergeService could not resolve worktree id=${JSON.stringify(worktreeId)}`,
        })
      }
      const worktree = found.data

      const preflight = await deps.preflight.check({ worktreeId })
      if (!preflight.ok) return preflight
      if (preflight.data.status === 'blocked') {
        const blockers = preflight.data.checks.flatMap((check) =>
          check.outcome === 'failed' && check.blocker !== undefined ? [check.blocker] : [],
        )
        const hard = blockers.filter((blocker) => !blocker.overridable)
        const describe = (blocker: MergePreflightBlocker) => `${blocker.code}: ${blocker.message}`
        if (hard.length > 0) {
          // Hard blockers never open a decision (§9.2) — they fail directly.
          return fail({
            code: 'MERGE_BLOCKED',
            message: `Merge is blocked: ${hard.map(describe).join(' ')}`,
            retryable: true,
            detail: `worktree=${worktreeId} blockers=${blockers.map((blocker) => blocker.code).join(',')}`,
          })
        }
        if (force !== true) {
          // TASK-130 (ADR-0014 §3): only overridable blockers — open the
          // persisted decision (dedupeKey keeps one open row per worktree) and
          // still answer MERGE_BLOCKED; force_merge re-enters with force below.
          // The run reference is attached only while the row exists — the FK
          // rejects a dangling id (e.g. the run was already retention-deleted).
          let runRef: { runId?: string } = {}
          if (worktree.runId !== undefined) {
            const run = deps.runs.getById(worktree.runId)
            if (run.ok && run.data !== null) runRef = { runId: worktree.runId }
          }
          const opened = deps.decisions?.open({
            workspaceId: worktree.workspaceId,
            kind: 'merge_blocked',
            severity: 'warning',
            dedupeKey: `merge_blocked:${worktreeId}`,
            title: `Merging "${worktree.branch}" into "${worktree.baseBranch}" is blocked`,
            detail: { kind: 'merge_blocked', blockers },
            options: MERGE_BLOCKED_OPTIONS,
            worktreeId,
            ...runRef,
          })
          if (opened !== undefined && !opened.ok) {
            logger.error(
              { worktreeId, error: opened.error },
              'Failed to open the merge-blocked decision.',
            )
          }
          return fail({
            code: 'MERGE_BLOCKED',
            message: `Merge is blocked by overridable checks; rerun with force to proceed: ${blockers.map(describe).join(' ')}`,
            retryable: true,
            detail: `worktree=${worktreeId} blockers=${blockers.map((blocker) => blocker.code).join(',')}`,
          })
        }
      }

      const context = contextFor(worktree)
      if (!context.ok) return context

      const merged = await git(
        context.data,
        'merge',
        ['merge', '--no-edit', worktree.baseBranch],
        context.data.worktreeCwd,
        [0, 1],
      )
      if (!merged.ok) return merged

      if (merged.data.exitCode !== 0) {
        const mergeHead = await git(
          context.data,
          'rev-parse',
          ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'],
          context.data.worktreeCwd,
          [0, 1],
        )
        if (!mergeHead.ok) return mergeHead
        if (mergeHead.data.exitCode !== 0) {
          // Failed for a non-conflict reason; still no abort, no cleanup.
          return commandFailed('merge', merged.data)
        }
        const unmerged = await git(
          context.data,
          'diff',
          ['diff', '--name-only', '--diff-filter=U'],
          context.data.worktreeCwd,
        )
        if (!unmerged.ok) return unmerged
        const conflicts = unmerged.data.stdout.split('\n').filter((line) => line.length > 0)

        const conflicted = deps.worktrees.updateState(worktreeId, 'conflict', now())
        if (!conflicted.ok) return conflicted
        if (conflicted.data === null) {
          return fail({
            code: 'VALIDATION_FAILED',
            message: `Worktree "${worktreeId}" was not found.`,
            messageKey: 'errorMessage.worktreeNotFound',
            params: { id: worktreeId },
            retryable: false,
            detail: `MergeService lost worktree id=${JSON.stringify(worktreeId)} mid-merge`,
          })
        }
        markConflict(conflicted.data, conflicts)
        deps.events.emit('worktree.merge_conflict', {
          worktreeId,
          workspaceId: worktree.workspaceId,
          runId: worktree.runId,
          branch: worktree.branch,
          baseBranch: worktree.baseBranch,
          conflicts,
        })
        deps.events.emit('git.changed', { workspaceId: worktree.workspaceId })
        return {
          ok: true,
          data: { worktreeId, outcome: 'conflict', worktree: conflicted.data, conflicts },
        }
      }

      const advanced = await advanceBase(context.data, worktree)
      if (!advanced.ok) {
        // The in-worktree merge committed; only the base fast-forward failed.
        // Nothing is torn down — the worktree/branch hold the merged result
        // and a retry (or a manual fast-forward) completes the merge.
        return advanced
      }

      const done = deps.worktrees.update(worktreeId, { state: 'merged', mergedAt: now() }, now())
      if (!done.ok) return done
      if (done.data === null) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Worktree "${worktreeId}" was not found.`,
          messageKey: 'errorMessage.worktreeNotFound',
          params: { id: worktreeId },
          retryable: false,
          detail: `MergeService lost worktree id=${JSON.stringify(worktreeId)} mid-merge`,
        })
      }
      deps.events.emit('worktree.merged', {
        worktreeId,
        workspaceId: worktree.workspaceId,
        runId: worktree.runId,
        branch: worktree.branch,
        baseBranch: worktree.baseBranch,
      })
      deps.events.emit('git.changed', { workspaceId: worktree.workspaceId })
      return { ok: true, data: { worktreeId, outcome: 'merged', worktree: done.data } }
    },
  }

  // TASK-130 (ADR-0014 §3): force_merge re-enters the merge with the force
  // flag; cancel (also the §9.1 timeout default) is the no-op. The
  // subscription lives for the process — DecisionService.dispose() clears it.
  deps.decisions?.onResolved('merge_blocked', (decision) => {
    if (decision.resolution?.optionId !== 'force_merge') return
    const worktreeId = decision.worktreeId
    if (worktreeId === undefined) {
      logger.error({ decisionId: decision.id }, 'A merge_blocked decision carries no worktree id.')
      return
    }
    void service.merge({ worktreeId, force: true }).then((merged) => {
      if (!merged.ok) {
        logger.error(
          { worktreeId, error: merged.error },
          'The forced merge from a merge-blocked decision failed.',
        )
      }
    })
  })

  return service
}
