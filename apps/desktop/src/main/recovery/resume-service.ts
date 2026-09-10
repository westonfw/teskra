import { existsSync } from 'node:fs'

import type { AgentRun, IpcResult, ResumeAgentRunRequest, Workspace } from '@teskra/contracts'

import type { AgentManager } from '../agents/agent-manager'
import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { WorktreeRepository } from '../db/repositories/worktree-repository'
import { type InternalAppError, toPublicError } from '../errors'
import type { GitManager } from '../git/git-manager'
import type { ProcessManager } from '../process/process-manager'
import type { WorkspaceRuntime } from '../workspace/runtime'

const RESUMABLE_WORKTREE_STATES = new Set(['ready', 'dirty', 'conflict'])

export interface ResumeService {
  resume(request: ResumeAgentRunRequest): Promise<IpcResult<AgentRun>>
}

export interface ResumeServiceDeps {
  readonly runs: Pick<AgentRunRepository, 'getById'>
  readonly workspaces: Pick<WorkspaceRepository, 'getById'>
  readonly worktrees: Pick<WorktreeRepository, 'getById'>
  readonly processes: Pick<ProcessManager, 'list'>
  readonly git: Pick<GitManager, 'branch'>
  readonly agentManager: Pick<AgentManager, 'resume'>
  readonly resolveRuntime: (workspace: Workspace) => IpcResult<WorkspaceRuntime>
  readonly pathExists?: (path: string) => boolean
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function unavailable(message: string, detail: string): IpcResult<never> {
  return fail({ code: 'VALIDATION_FAILED', message, retryable: true, detail })
}

/** TASK-042 restores a Run environment; it never treats a persisted PID as a live session. */
export function createResumeService(deps: ResumeServiceDeps): ResumeService {
  const pathExists = deps.pathExists ?? existsSync

  return {
    async resume(request) {
      const found = deps.runs.getById(request.runId)
      if (!found.ok) return found
      if (found.data === null) {
        return unavailable(`Agent run "${request.runId}" was not found.`, 'resume target missing')
      }
      const run = found.data
      if (run.status !== 'interrupted') {
        return unavailable(
          'Only interrupted Agent runs can be resumed.',
          `run=${run.id} status=${run.status}`,
        )
      }

      const oldProcessStillPresent = deps.processes
        .list()
        .some(
          (process) =>
            process.agentRunId === run.id ||
            process.id === run.processId ||
            (run.pid !== undefined && process.pid === run.pid),
        )
      if (oldProcessStillPresent) {
        return unavailable(
          'The interrupted Run still has a live process and cannot be resumed safely.',
          `run=${run.id} persisted process=${run.processId ?? 'none'} pid=${String(run.pid ?? 'none')}`,
        )
      }

      const workspace = deps.workspaces.getById(run.workspaceId)
      if (!workspace.ok) return workspace
      if (workspace.data === null) {
        return unavailable('The Run workspace no longer exists.', `workspace=${run.workspaceId}`)
      }
      const runtime = deps.resolveRuntime(workspace.data)
      if (!runtime.ok) return runtime
      const validation = runtime.data.validate()
      if (!validation.ok) return validation
      const workspacePath = runtime.data.resolveHostPath(
        runtime.data.resolveCwd(workspace.data.path),
      )
      if (!workspacePath.ok) return workspacePath
      if (!pathExists(workspacePath.data)) {
        return unavailable(
          'The Run workspace directory no longer exists.',
          `workspace=${workspace.data.id} path=${workspace.data.path}`,
        )
      }

      const branches = await deps.git.branch(workspace.data.id)
      if (!branches.ok) return branches
      if (run.worktreeId === undefined) {
        if (branches.data.detached) {
          return unavailable(
            'The workspace is in detached HEAD state.',
            `workspace=${workspace.data.id}`,
          )
        }
      } else {
        const worktree = deps.worktrees.getById(run.worktreeId)
        if (!worktree.ok) return worktree
        if (worktree.data === null || worktree.data.workspaceId !== workspace.data.id) {
          return unavailable(
            'The Run worktree no longer exists.',
            `run=${run.id} worktree=${run.worktreeId}`,
          )
        }
        if (!RESUMABLE_WORKTREE_STATES.has(worktree.data.state)) {
          return unavailable(
            'The Run worktree is not in a resumable state.',
            `worktree=${worktree.data.id} state=${worktree.data.state}`,
          )
        }
        const worktreePath = runtime.data.resolveHostPath(
          runtime.data.resolveCwd(worktree.data.path),
        )
        if (!worktreePath.ok) return worktreePath
        if (!pathExists(worktreePath.data)) {
          return unavailable(
            'The Run worktree directory no longer exists.',
            `worktree=${worktree.data.id} path=${worktree.data.path}`,
          )
        }
        if (!branches.data.branches.includes(worktree.data.branch)) {
          return unavailable(
            'The Run worktree branch no longer exists.',
            `worktree=${worktree.data.id} branch=${worktree.data.branch}`,
          )
        }
      }

      return deps.agentManager.resume(request)
    },
  }
}
