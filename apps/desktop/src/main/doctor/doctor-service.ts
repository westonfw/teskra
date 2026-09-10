import { accessSync, constants, existsSync } from 'node:fs'

import type {
  AgentDefinition,
  DoctorCheck,
  DoctorReport,
  DoctorSeverity,
  IpcResult,
  RunDoctorRequest,
  Workspace,
} from '@teskra/contracts'

import type { AgentDetector } from '../agents/agent-detector'
import type { AgentRegistry } from '../agents/agent-registry'
import type { TeskraDatabase } from '../db'
import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { WorktreeRepository } from '../db/repositories/worktree-repository'
import type { GitManager } from '../git/git-manager'
import type { TeskraPaths } from '../paths'
import type { CommandRunner } from '../process/command-runner'
import type { ProcessManager } from '../process/process-manager'
import type { WorkspaceRuntime } from '../workspace/runtime'
import type { WslManager } from '../workspace/wsl-manager'

const PROBE_TIMEOUT_MS = 10_000
const BROKEN_WORKTREE_STATES = new Set(['missing', 'orphaned', 'conflict'])
const PATH_BACKED_WORKTREE_STATES = new Set(['creating', 'ready', 'dirty', 'conflict'])

export interface DoctorService {
  run(request?: RunDoctorRequest): Promise<IpcResult<DoctorReport>>
}

export interface DoctorServiceDeps {
  readonly paths: Pick<TeskraPaths, 'home'>
  readonly database: Pick<TeskraDatabase, 'connection' | 'filePath'>
  readonly commands: CommandRunner
  readonly wsl: Pick<WslManager, 'inspect'>
  readonly registry: Pick<AgentRegistry, 'list'>
  readonly detector: Pick<AgentDetector, 'detect'>
  readonly workspaces: Pick<WorkspaceRepository, 'getById'>
  readonly worktrees: Pick<WorktreeRepository, 'listByWorkspace'>
  readonly runs: Pick<AgentRunRepository, 'listActive' | 'listByWorkspace'>
  readonly processes: Pick<ProcessManager, 'list'>
  readonly git: Pick<GitManager, 'status' | 'branch'>
  readonly resolveRuntime: (workspace: Workspace) => IpcResult<WorkspaceRuntime>
  readonly pathExists?: (path: string) => boolean
  readonly canAccessDataDirectory?: (path: string) => boolean
  readonly now?: () => string
}

function check(
  id: string,
  label: string,
  outcome: DoctorCheck['outcome'],
  severity: DoctorSeverity,
  summary: string,
  detail?: string,
  relatedIds?: readonly string[],
): DoctorCheck {
  return {
    id,
    label,
    outcome,
    severity,
    summary,
    ...(detail === undefined ? {} : { detail }),
    ...(relatedIds === undefined || relatedIds.length === 0 ? {} : { relatedIds: [...relatedIds] }),
  }
}

function pass(id: string, label: string, summary: string, detail?: string): DoctorCheck {
  return check(id, label, 'pass', 'info', summary, detail)
}

function skipped(id: string, label: string, summary: string): DoctorCheck {
  return check(id, label, 'skipped', 'info', summary)
}

function issue(
  id: string,
  label: string,
  severity: Exclude<DoctorSeverity, 'info'>,
  summary: string,
  detail?: string,
  relatedIds?: readonly string[],
): DoctorCheck {
  return check(id, label, 'issue', severity, summary, detail, relatedIds)
}

function overallSeverity(checks: readonly DoctorCheck[]): DoctorSeverity {
  if (checks.some(({ outcome, severity }) => outcome === 'issue' && severity === 'error')) {
    return 'error'
  }
  return checks.some(({ outcome }) => outcome === 'issue') ? 'warning' : 'info'
}

function processMatchesRun(
  run: { readonly id: string; readonly processId?: string; readonly pid?: number },
  processes: ReturnType<ProcessManager['list']>,
): boolean {
  return processes.some(
    (process) =>
      process.agentRunId === run.id && process.id === run.processId && process.pid === run.pid,
  )
}

function isConflictCode(code: string): boolean {
  return code.includes('U') || code === 'AA' || code === 'DD'
}

/** TASK-041 diagnostic aggregation. It observes state and never repairs or mutates it. */
export function createDoctorService(deps: DoctorServiceDeps): DoctorService {
  const pathExists = deps.pathExists ?? existsSync
  const canAccessDataDirectory =
    deps.canAccessDataDirectory ??
    ((path: string) => {
      try {
        accessSync(path, constants.R_OK | constants.W_OK)
        return true
      } catch {
        return false
      }
    })
  const now = deps.now ?? (() => new Date().toISOString())

  return {
    async run(request = {}) {
      const checks: DoctorCheck[] = []
      let workspace: Workspace | undefined
      let runtime: WorkspaceRuntime | undefined

      if (request.workspaceId !== undefined) {
        const found = deps.workspaces.getById(request.workspaceId)
        if (!found.ok) {
          checks.push(
            issue(
              'workspace',
              'Workspace',
              'error',
              'Workspace records could not be read.',
              found.error.message,
            ),
          )
        } else if (found.data === null) {
          checks.push(
            issue(
              'workspace',
              'Workspace',
              'error',
              `Workspace "${request.workspaceId}" was not found.`,
            ),
          )
        } else {
          workspace = found.data
          const resolved = deps.resolveRuntime(workspace)
          const validation = resolved.ok ? resolved.data.validate() : resolved
          const hostPath =
            resolved.ok && validation.ok
              ? resolved.data.resolveHostPath(resolved.data.resolveCwd(workspace.path))
              : undefined
          if (!resolved.ok || !validation.ok || hostPath?.ok !== true) {
            const error = !resolved.ok
              ? resolved.error
              : !validation.ok
                ? validation.error
                : hostPath !== undefined && !hostPath.ok
                  ? hostPath.error
                  : undefined
            checks.push(
              issue(
                'workspace',
                'Workspace',
                'error',
                'The workspace runtime or path is unavailable.',
                error?.message,
                [workspace.id],
              ),
            )
          } else if (!pathExists(hostPath.data)) {
            checks.push(
              issue(
                'workspace',
                'Workspace',
                'error',
                'The workspace directory does not exist.',
                workspace.path,
                [workspace.id],
              ),
            )
          } else {
            runtime = resolved.data
            checks.push(
              pass('workspace', 'Workspace', `${workspace.name} is accessible.`, workspace.path),
            )
          }
        }
      } else {
        checks.push(skipped('workspace', 'Workspace', 'No workspace is selected.'))
      }

      const gitProbe = await deps.commands.run({
        command: 'git',
        args: ['--version'],
        timeoutMs: PROBE_TIMEOUT_MS,
        ...(runtime === undefined
          ? {}
          : { runtime, cwd: runtime.resolveCwd(workspace?.path ?? '') }),
      })
      checks.unshift(
        gitProbe.ok && gitProbe.data.exitCode === 0
          ? pass('git', 'Git', 'Git is available.', gitProbe.data.stdout.trim())
          : issue(
              'git',
              'Git',
              'error',
              'Git is unavailable.',
              gitProbe.ok ? gitProbe.data.stderr.trim() : gitProbe.error.message,
            ),
      )

      const wsl = await deps.wsl.inspect()
      checks.splice(
        1,
        0,
        wsl.ok
          ? pass(
              'wsl',
              'WSL',
              'WSL is available.',
              wsl.data.version === undefined ? undefined : `Version ${wsl.data.version}`,
            )
          : issue('wsl', 'WSL', 'warning', 'WSL is unavailable.', wsl.error.message),
      )

      if (workspace?.runtime.kind === 'wsl') {
        const distro = workspace.runtime.distro ?? (wsl.ok ? wsl.data.effectiveDefault : undefined)
        const installed =
          distro !== undefined &&
          wsl.ok &&
          wsl.data.distributions.some(
            ({ name }) => name.toLocaleLowerCase() === distro.toLocaleLowerCase(),
          )
        checks.splice(
          2,
          0,
          installed
            ? pass('distro', 'WSL distribution', `${distro} is installed.`)
            : issue(
                'distro',
                'WSL distribution',
                'error',
                distro === undefined
                  ? 'No WSL distribution is configured.'
                  : `WSL distribution "${distro}" is not installed.`,
              ),
        )
      } else if (wsl.ok && wsl.data.distributions.length > 0) {
        checks.splice(
          2,
          0,
          pass(
            'distro',
            'WSL distribution',
            `${String(wsl.data.distributions.length)} distribution(s) installed.`,
          ),
        )
      } else {
        checks.splice(2, 0, skipped('distro', 'WSL distribution', 'No WSL distribution to check.'))
      }

      const definitions = deps.registry.list()
      const agentChecks = await Promise.all(
        definitions.map(async (definition: AgentDefinition): Promise<DoctorCheck> => {
          const id = `agent:${definition.id}`
          if (workspace === undefined || runtime === undefined) {
            return skipped(id, definition.name, 'Select a valid workspace to check this Agent.')
          }
          const detected = await deps.detector.detect({
            agentId: definition.id,
            runtime: workspace.runtime,
            refresh: true,
          })
          if (!detected.ok) {
            return issue(
              id,
              definition.name,
              'warning',
              'Agent detection failed.',
              detected.error.message,
            )
          }
          return detected.data.installed
            ? pass(
                id,
                definition.name,
                `${definition.name} is available.`,
                detected.data.version ?? detected.data.executable,
              )
            : issue(
                id,
                definition.name,
                'warning',
                `${definition.name} is not installed in this runtime.`,
                detected.data.error,
              )
        }),
      )
      checks.splice(3, 0, ...agentChecks)

      const dataDirectory = deps.paths.home()
      checks.push(
        canAccessDataDirectory(dataDirectory)
          ? pass(
              'data-directory',
              'Data directory',
              'The data directory is readable and writable.',
              dataDirectory,
            )
          : issue(
              'data-directory',
              'Data directory',
              'error',
              'The data directory is not readable and writable.',
              dataDirectory,
            ),
      )

      let databaseHealthy = deps.database.connection.open
      if (databaseHealthy) {
        try {
          deps.database.connection.prepare('SELECT 1').get()
        } catch {
          databaseHealthy = false
        }
      }
      checks.push(
        databaseHealthy
          ? pass(
              'database',
              'SQLite',
              'The database is open and responds to queries.',
              deps.database.filePath,
            )
          : issue(
              'database',
              'SQLite',
              'error',
              'The database is unavailable.',
              deps.database.filePath,
            ),
      )

      if (workspace === undefined || runtime === undefined) {
        checks.push(
          skipped('worktree', 'Worktree', 'No valid workspace to inspect.'),
          skipped('branch', 'Branch', 'No valid workspace to inspect.'),
          skipped('conflict', 'Conflict', 'No valid workspace to inspect.'),
        )
      } else {
        const [worktrees, runs, branches, status] = await Promise.all([
          // includeArchived: Doctor audits every record, hidden ones included.
          Promise.resolve(deps.worktrees.listByWorkspace(workspace.id, undefined, true)),
          Promise.resolve(deps.runs.listByWorkspace(workspace.id)),
          deps.git.branch(workspace.id),
          deps.git.status(workspace.id),
        ])

        if (!worktrees.ok || !runs.ok) {
          checks.push(
            issue(
              'worktree',
              'Worktree',
              'error',
              'Worktree records could not be inspected.',
              !worktrees.ok ? worktrees.error.message : runs.ok ? undefined : runs.error.message,
            ),
          )
        } else if (
          worktrees.data.length === 0 &&
          runs.data.every((run) => run.worktreeId === undefined)
        ) {
          checks.push(
            skipped('worktree', 'Worktree', 'No worktrees are recorded for this workspace.'),
          )
        } else {
          const runById = new Map(runs.data.map((run) => [run.id, run]))
          const worktreeById = new Map(worktrees.data.map((worktree) => [worktree.id, worktree]))
          const broken = worktrees.data.filter((worktree) => {
            if (BROKEN_WORKTREE_STATES.has(worktree.state)) return true
            if (PATH_BACKED_WORKTREE_STATES.has(worktree.state)) {
              const hostPath = runtime.resolveHostPath(runtime.resolveCwd(worktree.path))
              if (!hostPath.ok || !pathExists(hostPath.data)) return true
            }
            const linkedRun = worktree.runId === undefined ? undefined : runById.get(worktree.runId)
            return worktree.runId !== undefined && linkedRun?.worktreeId !== worktree.id
          })
          const inconsistentRuns = runs.data.filter(
            (run) =>
              run.worktreeId !== undefined && worktreeById.get(run.worktreeId)?.runId !== run.id,
          )
          const brokenIds = [
            ...new Set([...broken.map(({ id }) => id), ...inconsistentRuns.map(({ id }) => id)]),
          ]
          checks.push(
            brokenIds.length === 0
              ? pass(
                  'worktree',
                  'Worktree',
                  `${String(worktrees.data.length)} worktree record(s) are consistent.`,
                )
              : issue(
                  'worktree',
                  'Worktree',
                  'error',
                  `${String(brokenIds.length)} broken or inconsistent worktree link(s) found.`,
                  undefined,
                  brokenIds,
                ),
          )
        }

        checks.push(
          !branches.ok
            ? issue(
                'branch',
                'Branch',
                'error',
                'Git branches could not be inspected.',
                branches.error.message,
              )
            : branches.data.detached
              ? issue('branch', 'Branch', 'warning', 'The workspace is in detached HEAD state.')
              : workspace.defaultBranch !== undefined &&
                  !branches.data.branches.includes(workspace.defaultBranch)
                ? issue(
                    'branch',
                    'Branch',
                    'warning',
                    `Configured default branch "${workspace.defaultBranch}" does not exist.`,
                  )
                : pass(
                    'branch',
                    'Branch',
                    `Current branch: ${branches.data.current ?? 'unknown'}.`,
                  ),
        )

        if (!status.ok) {
          checks.push(
            issue(
              'conflict',
              'Conflict',
              'error',
              'Git conflicts could not be inspected.',
              status.error.message,
            ),
          )
        } else {
          const conflicts = status.data.entries.filter(({ code }) => isConflictCode(code))
          checks.push(
            conflicts.length === 0
              ? pass('conflict', 'Conflict', 'No unresolved Git conflicts were found.')
              : issue(
                  'conflict',
                  'Conflict',
                  'error',
                  `${String(conflicts.length)} unresolved Git conflict(s) found.`,
                  undefined,
                  conflicts.map(({ path }) => path),
                ),
          )
        }
      }

      const activeRuns = deps.runs.listActive()
      if (!activeRuns.ok) {
        checks.push(
          issue(
            'run',
            'Run',
            'error',
            'Active Runs could not be inspected.',
            activeRuns.error.message,
          ),
        )
      } else {
        const relevant =
          request.workspaceId === undefined
            ? activeRuns.data
            : activeRuns.data.filter(({ workspaceId }) => workspaceId === request.workspaceId)
        const processes = deps.processes.list()
        const stale = relevant.filter(
          (run) => run.status === 'running' && !processMatchesRun(run, processes),
        )
        checks.push(
          stale.length === 0
            ? pass('run', 'Run', `${String(relevant.length)} active Run record(s) are consistent.`)
            : issue(
                'run',
                'Run',
                'error',
                `${String(stale.length)} stale running Run(s) have no matching process.`,
                'Run startup reconciliation or resume before continuing.',
                stale.map(({ id }) => id),
              ),
        )
      }

      const severity = overallSeverity(checks)
      return {
        ok: true,
        data: {
          generatedAt: now(),
          ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
          severity,
          issueCount: checks.filter(({ outcome }) => outcome === 'issue').length,
          checks,
        },
      }
    },
  }
}
