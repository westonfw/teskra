import { existsSync } from 'node:fs'

import type {
  AgentRun,
  IpcResult,
  PublicAppError,
  WorkbenchEvents,
  Workspace,
} from '@teskra/contracts'

import type { AgentEventRepository } from '../db/repositories/agent-event-repository'
import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { TaskRepository } from '../db/repositories/task-repository'
import type { Worktree, WorktreeRepository } from '../db/repositories/worktree-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { EventBus } from '../events/event-bus'
import { getLogger } from '../logger'
import type { CommandRunner } from '../process/command-runner'
import type { HostProcessControl } from '../process/host-processes'
import type { ProcessManager } from '../process/process-manager'
import type { RunLogStore } from '../agents/run-log-store'
import type { WorkspaceRuntime } from '../workspace/runtime'

const GIT_PROBE_TIMEOUT_MS = 10_000
const CHECKABLE_WORKTREE_STATES = new Set<Worktree['state']>([
  'creating',
  'ready',
  'dirty',
  'conflict',
])

export type InterruptionReason = 'process_dead' | 'workspace_missing' | 'worktree_broken'

export interface BrokenWorktree {
  readonly id: string
  readonly state: 'missing' | 'orphaned'
}

export interface ReconciliationReport {
  readonly scannedRuns: number
  readonly missingWorkspaceIds: readonly string[]
  readonly brokenWorktrees: readonly BrokenWorktree[]
  readonly interruptedRunIds: readonly string[]
  /**
   * P0-2: runs whose previous-instance process was still alive on the host
   * and was terminated before the run was marked interrupted.
   */
  readonly terminatedSurvivorRunIds: readonly string[]
  /**
   * P0-2: runs whose process survived AND could not be terminated. These are
   * deliberately left in their active status — interrupting them while the
   * Agent keeps writing would invite a double-write on resume.
   */
  readonly survivingRunIds: readonly string[]
}

export interface ReconciliationService {
  reconcile(): Promise<IpcResult<ReconciliationReport>>
}

export interface ReconciliationServiceDeps {
  readonly runs: AgentRunRepository
  readonly agentEvents: AgentEventRepository
  readonly workspaces: WorkspaceRepository
  readonly worktrees: WorktreeRepository
  readonly tasks: TaskRepository
  readonly processes: Pick<ProcessManager, 'list'>
  readonly commands: CommandRunner
  /**
   * P0-2: host-side pid probe/terminate. The in-process registry (`processes`)
   * is empty after a restart, so without this every previously-running run
   * looks dead even while its Agent process is still alive on the host.
   * Optional so existing tests keep registry-only semantics by default.
   */
  readonly hostProcesses?: HostProcessControl
  readonly events: EventBus<WorkbenchEvents>
  readonly runLogs: RunLogStore
  readonly resolveRuntime: (workspace: Workspace) => IpcResult<WorkspaceRuntime>
  readonly pathExists?: (path: string) => boolean
  readonly now?: () => string
}

interface WorkspaceHealth {
  readonly workspace: Workspace
  readonly runtime?: WorkspaceRuntime | undefined
  readonly exists: boolean
}

function hostPath(runtime: WorkspaceRuntime, path: string): IpcResult<string> {
  return runtime.resolveHostPath(runtime.resolveCwd(path))
}

/** TASK-040 startup repair: reconciles persistent intent against live runtime truth. */
export function createReconciliationService(
  deps: ReconciliationServiceDeps,
): ReconciliationService {
  const logger = getLogger('runtime')
  const pathExists = deps.pathExists ?? existsSync
  const now = deps.now ?? (() => new Date().toISOString())

  return {
    async reconcile() {
      const listedWorkspaces = deps.workspaces.list()
      if (!listedWorkspaces.ok) return listedWorkspaces

      const workspaceHealth = new Map<string, WorkspaceHealth>()
      const missingWorkspaceIds: string[] = []
      for (const workspace of listedWorkspaces.data) {
        const resolved = deps.resolveRuntime(workspace)
        const runtime = resolved.ok ? resolved.data : undefined
        const validation = runtime?.validate()
        const path = runtime === undefined ? undefined : hostPath(runtime, workspace.path)
        let accessible = false
        if (resolved.ok && validation?.ok === true && path?.ok === true) {
          try {
            accessible = pathExists(path.data)
          } catch {
            accessible = false
          }
        }
        workspaceHealth.set(workspace.id, { workspace, runtime, exists: accessible })
        if (!accessible) missingWorkspaceIds.push(workspace.id)
      }

      const brokenWorktrees: BrokenWorktree[] = []
      const worktreeHealth = new Map<string, Worktree['state']>()
      for (const workspace of listedWorkspaces.data) {
        // includeArchived: reconciliation repairs git reality regardless of
        // the TASK-047 display marker.
        const listed = deps.worktrees.listByWorkspace(workspace.id, undefined, true)
        if (!listed.ok) return listed
        const health = workspaceHealth.get(workspace.id)
        for (const worktree of listed.data) {
          if (worktree.state === 'missing' || worktree.state === 'orphaned') {
            brokenWorktrees.push({ id: worktree.id, state: worktree.state })
            worktreeHealth.set(worktree.id, worktree.state)
            continue
          }
          worktreeHealth.set(worktree.id, worktree.state)
          if (!CHECKABLE_WORKTREE_STATES.has(worktree.state) || health?.exists !== true) continue
          const runtime = health.runtime
          if (runtime === undefined) continue
          const path = hostPath(runtime, worktree.path)
          let exists = false
          if (path.ok) {
            try {
              exists = pathExists(path.data)
            } catch {
              exists = false
            }
          }
          let state: BrokenWorktree['state'] | undefined
          if (!exists) {
            state = 'missing'
          } else {
            const git = await deps.commands.run({
              command: 'git',
              args: ['rev-parse', '--is-inside-work-tree'],
              cwd: runtime.resolveCwd(worktree.path),
              runtime,
              timeoutMs: GIT_PROBE_TIMEOUT_MS,
            })
            if (!git.ok) {
              // The probe itself failed (timeout, spawn error, WSL not ready
              // yet at startup): that says nothing about the worktree, so
              // leave its state unchanged instead of mislabeling it orphaned.
              logger.warn(
                { worktreeId: worktree.id, error: git.error },
                'Worktree Git probe failed; state left unchanged.',
              )
            } else if (git.data.exitCode !== 0 || git.data.stdout.trim() !== 'true') {
              state = 'orphaned'
            }
          }
          if (state !== undefined) {
            const updated = deps.worktrees.updateState(worktree.id, state, now())
            if (!updated.ok) return updated
            brokenWorktrees.push({ id: worktree.id, state })
            worktreeHealth.set(worktree.id, state)
          }
        }
      }

      const active = deps.runs.listActive()
      if (!active.ok) return active
      const liveProcesses = new Map(
        deps.processes
          .list()
          .filter((process) => process.agentRunId !== undefined)
          .map((process) => [process.agentRunId as string, process]),
      )
      const interruptedRunIds: string[] = []
      const interruptedTaskIds = new Set<string>()
      const terminatedSurvivorRunIds: string[] = []
      const survivingRunIds: string[] = []

      /**
       * P0-2: the in-process registry is empty after a restart, so probe the
       * recorded pid before declaring a run's process dead. A live survivor
       * cannot be re-adopted (its PTY handle died with the previous
       * instance), so it is terminated — resuming onto a worktree a live
       * Agent still writes to would double-write.
       *
       * A pid alone does not name a process: after a reboot or pid wraparound
       * the recorded number belongs to an unrelated process, and killing it
       * (on Windows `taskkill /T /F` takes the whole tree) would be an
       * arbitrary kill. Runs that carry a pid identity token (migration 011)
       * are verified against a fresh start-time read; a mismatch — or a gone
       * pid — means the recorded process is dead, without touching whatever
       * owns the pid now. Legacy rows without a token fall back to the
       * probe-only behavior.
       */
      const terminateSurvivor = async (run: AgentRun): Promise<'none' | 'terminated' | 'alive'> => {
        if (deps.hostProcesses === undefined || run.pid === undefined) return 'none'
        if (run.pidIdentity !== undefined) {
          const identity = await deps.hostProcesses.identity(run.pid)
          if (!identity.ok) {
            logger.warn(
              { runId: run.id, pid: run.pid, error: identity.error },
              'Host pid identity read failed; treating the process as dead.',
            )
            return 'none'
          }
          if (identity.data === null) return 'none'
          if (identity.data !== run.pidIdentity) {
            logger.warn(
              { runId: run.id, pid: run.pid },
              'The recorded pid now belongs to an unrelated process; treating the Agent process as dead.',
            )
            return 'none'
          }
        } else {
          const probe = await deps.hostProcesses.probe(run.pid)
          if (!probe.ok) {
            logger.warn(
              { runId: run.id, pid: run.pid, error: probe.error },
              'Host pid probe failed; treating the process as dead.',
            )
            return 'none'
          }
          if (!probe.data) return 'none'
        }
        const terminated = await deps.hostProcesses.terminate(run.pid)
        if (terminated.ok) {
          logger.warn(
            { runId: run.id, pid: run.pid },
            'Terminated a surviving Agent process from a previous instance.',
          )
          return 'terminated'
        }
        logger.error(
          { runId: run.id, pid: run.pid, error: terminated.error },
          "A previous instance's Agent process is still alive and could not be terminated; the run is left active.",
        )
        survivingRunIds.push(run.id)
        return 'alive'
      }

      for (const run of active.data) {
        let reason: InterruptionReason | undefined
        if (workspaceHealth.get(run.workspaceId)?.exists !== true) {
          reason = 'workspace_missing'
        } else if (
          run.worktreeId !== undefined &&
          (!worktreeHealth.has(run.worktreeId) ||
            ['missing', 'orphaned'].includes(worktreeHealth.get(run.worktreeId) as string))
        ) {
          reason = 'worktree_broken'
        } else {
          const live = liveProcesses.get(run.id)
          const processMatches =
            live !== undefined &&
            (run.processId === undefined || live.id === run.processId) &&
            (run.pid === undefined || live.pid === run.pid)
          if (!processMatches) {
            const survivor = await terminateSurvivor(run)
            // A survivor we failed to kill keeps its active status — flipping
            // it to interrupted while the Agent keeps running is exactly the
            // silent double-write P0-2 forbids.
            if (survivor === 'alive') continue
            if (survivor === 'terminated') terminatedSurvivorRunIds.push(run.id)
            reason = 'process_dead'
          }
        }
        if (reason === undefined) continue

        const timestamp = now()
        const error: PublicAppError = {
          code: 'PROCESS_NOT_FOUND',
          message: 'The Agent Run was interrupted because its runtime resources are unavailable.',
          retryable: true,
        }
        const initialized = deps.runLogs.initialize(run)
        if (!initialized.ok) {
          logger.error({ runId: run.id, error: initialized.error }, 'Run log recovery failed.')
        }
        const durable = deps.runLogs.appendEvent(run.id, 'agent.interrupted', { reason }, timestamp)
        if (!durable.ok) {
          logger.error(
            { runId: run.id, error: durable.error },
            'Interruption event was not durable.',
          )
        } else {
          const persisted = deps.agentEvents.append(
            {
              runId: run.id,
              seq: durable.data.seq,
              eventType: durable.data.eventType,
              payload: durable.data.payload,
            },
            timestamp,
          )
          if (!persisted.ok) {
            logger.error(
              { runId: run.id, error: persisted.error },
              'Interruption event DB write failed.',
            )
          }
        }
        const updated = deps.runs.update(
          run.id,
          { status: 'interrupted', finishedAt: timestamp, error },
          timestamp,
        )
        if (!updated.ok) return updated
        if (updated.data !== null) {
          const manifest = deps.runLogs.writeRun(updated.data)
          if (!manifest.ok) {
            logger.error({ runId: run.id, error: manifest.error }, 'Run manifest recovery failed.')
          }
        }
        // P1-1: interruption is a lifecycle transition — force an fsync so the
        // file authority can never trail the DB status across another crash.
        const flushed = deps.runLogs.flush(run.id)
        if (!flushed.ok) {
          logger.error({ runId: run.id, error: flushed.error }, 'Run log flush failed.')
        }
        deps.events.emit('agent.interrupted', { runId: run.id, reason })
        interruptedRunIds.push(run.id)
        if (run.taskId !== undefined) interruptedTaskIds.add(run.taskId)
      }

      for (const taskId of interruptedTaskIds) {
        const taskRuns = deps.runs.listByTask(taskId)
        if (!taskRuns.ok) return taskRuns
        if (
          taskRuns.data.some(({ status }) => ['queued', 'preparing', 'running'].includes(status))
        ) {
          continue
        }
        const task = deps.tasks.getById(taskId)
        if (!task.ok) return task
        if (task.data?.status !== 'running') continue
        const updated = deps.tasks.updateStatus(taskId, 'blocked', now())
        if (!updated.ok) return updated
        deps.events.emit('task.updated', { taskId })
      }

      return {
        ok: true,
        data: {
          scannedRuns: active.data.length,
          missingWorkspaceIds: missingWorkspaceIds.sort(),
          brokenWorktrees: brokenWorktrees.sort((left, right) => left.id.localeCompare(right.id)),
          interruptedRunIds: interruptedRunIds.sort(),
          terminatedSurvivorRunIds: terminatedSurvivorRunIds.sort(),
          survivingRunIds: survivingRunIds.sort(),
        },
      }
    },
  }
}
