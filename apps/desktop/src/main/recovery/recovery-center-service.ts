import { existsSync } from 'node:fs'

import type {
  AgentRun,
  IpcResult,
  ListRecoveryIssuesRequest,
  RecoveryIssue,
  RecoveryReport,
  Workspace,
} from '@teskra/contracts'
import { inspectRunWatchdog } from '@teskra/shared'

import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { WorktreeRepository } from '../db/repositories/worktree-repository'
import { type InternalAppError, toPublicError } from '../errors'
import type { GitManager } from '../git/git-manager'
import type { ProcessManager } from '../process/process-manager'
import type { WorkspaceRuntime } from '../workspace/runtime'

const BROKEN_WORKTREE_STATES = new Set(['missing', 'orphaned'])
const PATH_BACKED_WORKTREE_STATES = new Set(['creating', 'ready', 'dirty', 'conflict'])

export interface RecoveryCenterService {
  list(request?: ListRecoveryIssuesRequest): Promise<IpcResult<RecoveryReport>>
}

export interface RecoveryCenterServiceDeps {
  readonly workspaces: Pick<WorkspaceRepository, 'getById'>
  readonly worktrees: Pick<WorktreeRepository, 'listByWorkspace'>
  readonly runs: Pick<AgentRunRepository, 'listByWorkspace'>
  readonly processes: Pick<ProcessManager, 'list'>
  readonly git: Pick<GitManager, 'status'>
  readonly resolveRuntime: (workspace: Workspace) => IpcResult<WorkspaceRuntime>
  /** TASK-085 watchdog threshold, resolved per workspace from the config layers. */
  readonly resolveStalledThresholdMs: (workspaceId: string) => IpcResult<number>
  readonly pathExists?: (path: string) => boolean
  readonly now?: () => Date
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function isConflictCode(code: string): boolean {
  return code.includes('U') || code === 'AA' || code === 'DD'
}

function processMatchesRun(
  run: Pick<AgentRun, 'id' | 'processId' | 'pid'>,
  processes: ReturnType<ProcessManager['list']>,
): boolean {
  return processes.some(
    (process) =>
      process.agentRunId === run.id && process.id === run.processId && process.pid === run.pid,
  )
}

function issue(base: Omit<RecoveryIssue, 'id'>): RecoveryIssue {
  return { ...base, id: `${base.kind}:${base.runId ?? base.worktreeId ?? base.workspaceId}` }
}

/**
 * TASK-070: aggregates the five recoverable problem categories for one
 * workspace into a single report. Read-only like DoctorService — every action
 * is dispatched by the Renderer through the owning port (agent.resume,
 * worktree.validate/discard, page navigation).
 */
export function createRecoveryCenterService(deps: RecoveryCenterServiceDeps): RecoveryCenterService {
  const pathExists = deps.pathExists ?? existsSync
  const now = deps.now ?? (() => new Date())

  return {
    async list(request = {}) {
      const generatedAt = now()
      if (request.workspaceId === undefined) {
        return { ok: true, data: { generatedAt: generatedAt.toISOString(), issues: [] } }
      }

      const found = deps.workspaces.getById(request.workspaceId)
      if (!found.ok) return found
      if (found.data === null) {
        return fail({
          code: 'WORKSPACE_NOT_FOUND',
          message: 'The selected workspace no longer exists.',
          retryable: false,
          detail: `workspace=${request.workspaceId}`,
        })
      }
      const workspace = found.data
      const threshold = deps.resolveStalledThresholdMs(workspace.id)
      if (!threshold.ok) return threshold

      const [worktrees, runs, status] = await Promise.all([
        Promise.resolve(deps.worktrees.listByWorkspace(workspace.id)),
        Promise.resolve(deps.runs.listByWorkspace(workspace.id)),
        deps.git.status(workspace.id),
      ])
      if (!worktrees.ok) return worktrees
      if (!runs.ok) return runs

      const resolved = deps.resolveRuntime(workspace)
      const runtime = resolved.ok && resolved.data.validate().ok ? resolved.data : undefined

      const issues: RecoveryIssue[] = []

      // 1. Interrupted Runs — resumable via ResumeService (TASK-042).
      for (const run of runs.data.filter(({ status: runStatus }) => runStatus === 'interrupted')) {
        issues.push(
          issue({
            kind: 'interrupted_run',
            summary: `Run ${run.id} (${run.agentType}) was interrupted and can be resumed.`,
            ...(run.taskId === undefined ? {} : { detail: `Task ${run.taskId}` }),
            suggestedAction: 'resume',
            workspaceId: workspace.id,
            runId: run.id,
            ...(run.worktreeId === undefined ? {} : { worktreeId: run.worktreeId }),
          }),
        )
      }

      // 2-4. Worktree state categories from the persisted records (§132 八态).
      for (const worktree of worktrees.data) {
        const pathMissing =
          PATH_BACKED_WORKTREE_STATES.has(worktree.state) &&
          (runtime === undefined ||
            (() => {
              const hostPath = runtime.resolveHostPath(runtime.resolveCwd(worktree.path))
              return !hostPath.ok || !pathExists(hostPath.data)
            })())
        if (BROKEN_WORKTREE_STATES.has(worktree.state) || pathMissing) {
          issues.push(
            issue({
              kind: 'broken_worktree',
              summary: `Worktree ${worktree.branch} is ${
                pathMissing && !BROKEN_WORKTREE_STATES.has(worktree.state)
                  ? 'missing on disk'
                  : worktree.state
              }.`,
              detail: worktree.path,
              suggestedAction: 'repair',
              workspaceId: workspace.id,
              worktreeId: worktree.id,
              ...(worktree.runId === undefined ? {} : { runId: worktree.runId }),
            }),
          )
        } else if (worktree.state === 'dirty') {
          issues.push(
            issue({
              kind: 'dirty_worktree',
              summary: `Worktree ${worktree.branch} has uncommitted changes.`,
              detail: worktree.path,
              suggestedAction: 'inspect',
              workspaceId: workspace.id,
              worktreeId: worktree.id,
              ...(worktree.runId === undefined ? {} : { runId: worktree.runId }),
            }),
          )
        } else if (worktree.state === 'conflict') {
          issues.push(
            issue({
              kind: 'conflict',
              summary: `Worktree ${worktree.branch} has unresolved merge conflicts.`,
              detail: worktree.path,
              suggestedAction: 'inspect',
              workspaceId: workspace.id,
              worktreeId: worktree.id,
              ...(worktree.runId === undefined ? {} : { runId: worktree.runId }),
            }),
          )
        }
      }

      // 4b. Repository-level conflicts (e.g. an in-progress merge in the main checkout).
      if (status.ok) {
        const conflicts = status.data.entries.filter(({ code }) => isConflictCode(code))
        if (conflicts.length > 0) {
          issues.push(
            issue({
              kind: 'conflict',
              summary: `The workspace checkout has ${String(conflicts.length)} unresolved Git conflict(s).`,
              detail: conflicts.map(({ path }) => path).join(', '),
              suggestedAction: 'inspect',
              workspaceId: workspace.id,
            }),
          )
        }
      }

      // 5. Stale Processes — active runs whose process is gone or silent.
      const processes = deps.processes.list()
      const nowMs = generatedAt.getTime()
      for (const run of runs.data) {
        if (run.status === 'running' && !processMatchesRun(run, processes)) {
          issues.push(
            issue({
              kind: 'stale_process',
              summary: `Run ${run.id} (${run.agentType}) is marked running but its process is gone.`,
              detail: 'Startup reconciliation or resume may be required before continuing.',
              suggestedAction: 'inspect',
              workspaceId: workspace.id,
              runId: run.id,
            }),
          )
          continue
        }
        const watchdog = inspectRunWatchdog(run, nowMs, threshold.data)
        if (watchdog.possiblyStalled) {
          issues.push(
            issue({
              kind: 'stale_process',
              summary: `Run ${run.id} (${run.agentType}) has produced no output for ${String(
                Math.floor(watchdog.silentForMs / 60_000),
              )} minute(s).`,
              suggestedAction: 'inspect',
              workspaceId: workspace.id,
              runId: run.id,
            }),
          )
        }
      }

      return {
        ok: true,
        data: {
          generatedAt: generatedAt.toISOString(),
          workspaceId: workspace.id,
          issues,
        },
      }
    },
  }
}
