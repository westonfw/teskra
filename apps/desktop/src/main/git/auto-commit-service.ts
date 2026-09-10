import type { AgentRun, IpcResult, WorkbenchEvents, Workspace } from '@teskra/contracts'

import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { HandoffRepository } from '../db/repositories/handoff-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { Worktree, WorktreeRepository } from '../db/repositories/worktree-repository'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { CommandResult, CommandRunner } from '../process/command-runner'
import type { WorkspaceRuntime } from '../workspace/runtime'

/**
 * AutoCommitService (TASK-087, teskra-tasks.md; ADR-0003).
 *
 * When an Agent run completes, its worktree changes are committed locally:
 *
 * ```text
 * agent(<agentId>): <taskId> <summary>
 * ```
 *
 * Hard rules (pinned by tests):
 *
 * - Commits happen ONLY inside the run's worktree. A run without a worktreeId
 *   is skipped outright — the main workspace is never committed, and the
 *   resolved worktree cwd is asserted to differ from the repository cwd.
 * - No changes → no commit (`git status --porcelain` gate; no empty commits).
 * - NEVER a push: the only git verbs issued are status / add / commit /
 *   rev-parse. Push is NETWORK_WRITE and requires an explicit user action.
 * - A failed commit never fails the Run: the run row is left untouched
 *   (status stays `completed`), a warning is logged, and the uncommitted
 *   changes stay in the worktree.
 *
 * The service subscribes to `agent.completed`; on success it emits
 * `agent.committed` and `git.changed`. Git primitives go through
 * CommandRunner with the same runtime/cwd resolution as WorktreeManager —
 * GitManager.commit() cannot be reused because it anchors on the main
 * workspace cwd.
 */

const GIT_TIMEOUT_MS = 60_000

/** Conventional-commit subject ceiling; longer summaries are truncated. */
export const SUBJECT_LIMIT = 72

/** Fixed fallback when neither a Handoff summary nor a prompt exists. */
export const DEFAULT_SUMMARY = 'agent changes'

export type AutoCommitOutcome =
  | { readonly kind: 'committed'; readonly commitHash: string }
  | { readonly kind: 'skipped'; readonly reason: 'no-worktree' | 'no-changes' }

export interface AutoCommitService {
  /**
   * Runs one auto-commit pass for a completed run. Exposed for tests; the
   * `agent.completed` subscription drives it in production.
   */
  commitCompletedRun(runId: string): Promise<IpcResult<AutoCommitOutcome>>
  dispose(): void
}

export interface AutoCommitServiceDeps {
  readonly commands: CommandRunner
  readonly runs: AgentRunRepository
  readonly workspaces: WorkspaceRepository
  readonly worktrees: WorktreeRepository
  readonly handoffs: HandoffRepository
  readonly events: EventBus<WorkbenchEvents>
  readonly resolveRuntime: (workspace: Workspace) => IpcResult<WorkspaceRuntime>
}

interface GitContext {
  readonly runtime: WorkspaceRuntime
  /** Worktree cwd, runtime-side form — the only place commits may happen. */
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

/** First non-empty line of free text, collapsed to a single line. */
function firstLine(text: string | undefined): string | undefined {
  const line = text
    ?.split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0)
  return line === undefined || line.length === 0 ? undefined : line
}

/**
 * Builds the TASK-087 commit message. Fixed choice (pinned by tests): a run
 * without a taskId OMITS the task segment — `agent(<agentId>): <summary>` —
 * while the runId always lands in the body for bisect/backtracking.
 */
export function buildCommitMessage(input: {
  readonly agentId: string
  readonly taskId?: string
  readonly runId: string
  readonly summary: string
  readonly handoffSummary?: string
}): string {
  const scope =
    input.taskId === undefined ? input.summary : `${input.taskId} ${input.summary}`
  const rawSubject = `agent(${input.agentId}): ${scope}`
  const subject =
    rawSubject.length > SUBJECT_LIMIT ? rawSubject.slice(0, SUBJECT_LIMIT).trimEnd() : rawSubject
  const body = [input.handoffSummary?.trim(), `Run: ${input.runId}`]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join('\n\n')
  return `${subject}\n\n${body}`
}

export function createAutoCommitService(deps: AutoCommitServiceDeps): AutoCommitService {
  const logger = getLogger('git')

  const git = async (
    context: GitContext,
    operation: string,
    args: readonly string[],
    successExitCodes: readonly number[] = [0],
  ): Promise<IpcResult<CommandResult>> => {
    const result = await deps.commands.run({
      command: 'git',
      args,
      cwd: context.worktreeCwd,
      runtime: context.runtime,
      timeoutMs: GIT_TIMEOUT_MS,
    })
    if (!result.ok) return result
    return successExitCodes.includes(result.data.exitCode)
      ? result
      : commandFailed(operation, result.data)
  }

  const contextFor = (run: AgentRun, worktree: Worktree): IpcResult<GitContext> => {
    if (worktree.runId !== undefined && worktree.runId !== run.id) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'The worktree belongs to a different Agent run.',
        retryable: false,
        detail: `worktree=${worktree.id} record runId=${worktree.runId} requested run=${run.id}`,
      })
    }
    const workspace = deps.workspaces.getById(run.workspaceId)
    if (!workspace.ok) return workspace
    if (workspace.data === null) {
      return fail({
        code: 'WORKSPACE_NOT_FOUND',
        message: `Workspace "${run.workspaceId}" was not found.`,
        retryable: false,
        detail: `AutoCommitService could not resolve workspace id=${JSON.stringify(run.workspaceId)}`,
      })
    }
    const runtime = deps.resolveRuntime(workspace.data)
    if (!runtime.ok) return runtime
    const validated = runtime.data.validate()
    if (!validated.ok) return validated
    const worktreeCwd = runtime.data.resolveCwd(worktree.path)
    // Main-workspace protection: refuse if the "worktree" path resolves to the
    // repository itself — committing there would violate the core rule.
    const repoCwd = runtime.data.resolveCwd(workspace.data.gitRoot ?? workspace.data.path)
    if (worktreeCwd === repoCwd) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Refusing to auto-commit: the worktree path is the main workspace.',
        retryable: false,
        detail: `worktree=${worktree.id} path=${worktree.path} repo=${repoCwd}`,
      })
    }
    return { ok: true, data: { runtime: runtime.data, worktreeCwd } }
  }

  const summaryFor = (run: AgentRun): IpcResult<{ summary: string; handoffSummary?: string }> => {
    const handoff = deps.handoffs.getByRunId(run.id)
    if (!handoff.ok) return handoff
    const candidate = handoff.data?.payload?.['summary']
    const handoffSummary = typeof candidate === 'string' ? firstLine(candidate) : undefined
    return {
      ok: true,
      data: {
        summary: handoffSummary ?? firstLine(run.prompt) ?? DEFAULT_SUMMARY,
        ...(handoffSummary === undefined ? {} : { handoffSummary }),
      },
    }
  }

  let stopSubscription: () => void = () => {}

  const service: AutoCommitService = {
    async commitCompletedRun(runId) {
      const run = deps.runs.getById(runId)
      if (!run.ok) return run
      if (run.data === null) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Agent run "${runId}" was not found.`,
          retryable: false,
          detail: `AutoCommitService could not resolve run id=${JSON.stringify(runId)}`,
        })
      }
      // Never commit the main workspace: runs without a worktree skip.
      if (run.data.worktreeId === undefined) {
        return { ok: true, data: { kind: 'skipped', reason: 'no-worktree' } }
      }
      const worktree = deps.worktrees.getById(run.data.worktreeId)
      if (!worktree.ok) return worktree
      if (worktree.data === null) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Worktree "${run.data.worktreeId}" was not found.`,
          retryable: false,
          detail: `AutoCommitService could not resolve worktree id=${JSON.stringify(run.data.worktreeId)}`,
        })
      }
      const context = contextFor(run.data, worktree.data)
      if (!context.ok) return context

      // No empty commits: skip when the worktree is clean.
      const status = await git(context.data, 'status', ['status', '--porcelain'])
      if (!status.ok) return status
      if (status.data.stdout.trim().length === 0) {
        return { ok: true, data: { kind: 'skipped', reason: 'no-changes' } }
      }

      const summary = summaryFor(run.data)
      if (!summary.ok) return summary
      const staged = await git(context.data, 'add', ['add', '--all'])
      if (!staged.ok) return staged
      const message = buildCommitMessage({
        agentId: run.data.agentType,
        ...(run.data.taskId === undefined ? {} : { taskId: run.data.taskId }),
        runId: run.data.id,
        ...summary.data,
      })
      const committed = await git(context.data, 'commit', ['commit', '--message', message])
      if (!committed.ok) return committed
      const revision = await git(context.data, 'rev-parse', ['rev-parse', 'HEAD'])
      if (!revision.ok) return revision
      const commitHash = revision.data.stdout.trim()

      deps.events.emit('agent.committed', {
        runId: run.data.id,
        worktreeId: worktree.data.id,
        commitHash,
      })
      deps.events.emit('git.changed', { workspaceId: run.data.workspaceId })
      return { ok: true, data: { kind: 'committed', commitHash } }
    },

    dispose() {
      stopSubscription()
    },
  }

  stopSubscription = deps.events.subscribe('agent.completed', ({ runId }) => {
    void service
      .commitCompletedRun(runId)
      .then((outcome) => {
        if (!outcome.ok) {
          logger.warn(
            { runId, error: outcome.error },
            'Auto-commit failed; the run stays completed and its changes remain uncommitted.',
          )
        }
      })
      .catch((cause: unknown) => {
        logger.error({ runId, cause }, 'Unexpected auto-commit failure.')
      })
  })

  return service
}
