import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

import type {
  AgentRun,
  IpcResult,
  RetentionAuditEntry,
  RetentionConfig,
  RetentionPlan,
  RetentionPlanItem,
  RetentionPlanRequest,
  RetentionReport,
  RetentionRunRequest,
  WorkbenchEvents,
  Workspace,
} from '@teskra/contracts'

import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { HandoffRepository } from '../db/repositories/handoff-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { Worktree, WorktreeRepository } from '../db/repositories/worktree-repository'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { TeskraPaths } from '../paths'
import type { CommandResult, CommandRunner } from '../process/command-runner'
import type { WorkspaceRuntime } from '../workspace/runtime'

/**
 * RetentionService (TASK-069, teskra-tasks.md; plan §135).
 *
 * Time-based GC over three categories (thresholds come from the `retention`
 * config group, resolved per workspace through Config Layers):
 *
 * - merged worktrees: directory + DB record + agent branch are collected
 *   after `mergedWorktreeDays`. The branch is deleted only when a fresh
 *   `git merge-base --is-ancestor` check still proves it merged into the
 *   base branch — an unmerged branch (or one git can no longer prove merged)
 *   is NEVER deleted, and its worktree is left untouched too.
 * - run logs: terminal runs older than `completedRunLogsDays` lose the
 *   volatile log files (events.jsonl / terminal.log). The manifest,
 *   handoff.json, diff and artifacts stay — they carry the audit value.
 * - discarded runs: runs whose worktree is `discarded`, older than
 *   `discardedRunDays`, lose the whole run directory and the discarded
 *   worktree leftover. The agent_runs row is deleted only when no handoff
 *   DB record exists — handoff records are kept by default (ADR-0002
 *   post-hoc audit). Branches of discarded worktrees are never touched.
 * - worktree artifacts (TASK-133, Milestone 25 §11): build-output
 *   directories named in `worktreeArtifactPatterns` (matched against
 *   top-level and one-level-deep directory names only — no glob) are
 *   deleted from worktrees in a terminal state (`merged` / `discarded` /
 *   archived) or from `ready` / `dirty` worktrees that have no
 *   non-terminal run and have been idle for `worktreeArtifactIdleDays`.
 *   `conflict` worktrees, worktrees with a live run, and the repository
 *   main working tree are NEVER touched; symlink escapes beyond the
 *   worktree are skipped and audited (`ownsWorktreePath`, same shape as
 *   the P1-7 `ownsRunDir` gate). plan() lists an estimated size per item
 *   (du-style total; "unknown" when estimation exceeds 10 seconds).
 *
 * Guarantees pinned by tests: plan() never mutates; run() checks the abort
 * signal between items (cancellation leaves unprocessed items untouched);
 * every processed item yields an audit entry (what / why / when), mirrored
 * to the structured log. No new DB table — the report plus the log are the
 * audit trail.
 */

const GIT_TIMEOUT_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000
/** TASK-133: per-directory size-estimation ceiling; over it → "unknown". */
const SIZE_ESTIMATE_TIMEOUT_MS = 10_000

/** Runs eligible for log GC: nothing a live process could still append to. */
const LOG_COLLECTABLE_STATUSES = new Set<AgentRun['status']>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

/** TASK-133: a run in any other status still counts as activity on its worktree. */
const TERMINAL_RUN_STATUSES = LOG_COLLECTABLE_STATUSES

export interface RetentionService {
  plan(request?: RetentionPlanRequest): Promise<IpcResult<RetentionPlan>>
  run(request?: RetentionRunRequest, signal?: AbortSignal): Promise<IpcResult<RetentionReport>>
  /** Aborts the in-flight run between items; false when nothing was running. */
  cancel(): IpcResult<boolean>
  /**
   * Shutdown (P2-1): aborts the in-flight run (if any) and waits for it to
   * settle, so a GC in progress cannot keep deleting rows and files after
   * the composition root closed the database.
   */
  dispose(): Promise<void>
}

export interface RetentionServiceDeps {
  readonly commands: CommandRunner
  readonly workspaces: WorkspaceRepository
  readonly worktrees: WorktreeRepository
  readonly runs: AgentRunRepository
  readonly handoffs: Pick<HandoffRepository, 'getByRunId'>
  readonly events: EventBus<WorkbenchEvents>
  readonly paths: TeskraPaths
  readonly resolveRuntime: (workspace: Workspace) => IpcResult<WorkspaceRuntime>
  /** Resolves the `retention` config group through the Config Layers. */
  readonly resolvePolicy: (workspaceId?: string) => IpcResult<RetentionConfig>
  readonly now?: () => Date
  /** Filesystem probe for host-side paths; defaults to node:fs existsSync. */
  readonly pathExists?: (path: string) => boolean
  /** Test hook invoked at each item boundary, before the abort check. */
  readonly onItemStart?: (item: RetentionPlanItem) => void
  /**
   * TASK-133: du-style total size of a directory in bytes, or undefined when
   * the estimation exceeds `timeoutMs` ("unknown"). Tests inject a fake.
   */
  readonly measureDirectorySize?: (path: string, timeoutMs: number) => number | undefined
}

interface WorkspaceContext {
  readonly workspace: Workspace
  readonly runtime: WorkspaceRuntime
  /** Main repository cwd, runtime-side form. */
  readonly repoCwd: string
  readonly policy: RetentionConfig
}

interface CollectedPlan {
  readonly policy: RetentionConfig
  readonly items: RetentionPlanItem[]
  readonly contexts: ReadonlyMap<string, WorkspaceContext>
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

function ageDays(now: Date, iso: string): number | undefined {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return undefined
  return Math.max(0, Math.floor((now.getTime() - then) / DAY_MS))
}

export function createRetentionService(deps: RetentionServiceDeps): RetentionService {
  const pathExists = deps.pathExists ?? existsSync
  const now = deps.now ?? (() => new Date())
  let active: AbortController | null = null
  /** The in-flight run()'s promise, so dispose() can wait it out (P2-1). */
  let activeRun: Promise<IpcResult<RetentionReport>> | null = null

  /**
   * P1-7 ownership gate. `agent_runs.run_dir` is a DB column: a migration, a
   * manual edit, or a row created under a different TESKRA_HOME can point it
   * anywhere on the host. Recursive deletion only ever touches directories
   * below <home>/runs; anything else is skipped and audited. Real paths are
   * compared when they resolve (artifact-store pattern) so a symlinked runs
   * root or run directory cannot escape the check; a missing path falls back
   * to the lexical comparison.
   */
  const ownsRunDir = (runDir: string): boolean => {
    let root = resolve(join(deps.paths.home(), 'runs'))
    let target = resolve(runDir)
    try {
      root = realpathSync(root)
      target = realpathSync(runDir)
    } catch {
      // Missing directory: the lexical check below still applies.
    }
    return target !== root && target.startsWith(root + sep)
  }

  const foreignRunDirWarn = (runId: string, runDir: string): void => {
    getLogger('runtime').warn(
      { runId, runDir, runsRoot: join(deps.paths.home(), 'runs') },
      'Retention refused to delete a run directory outside the Teskra data root.',
    )
  }

  /**
   * TASK-133 ownership gate, same shape as ownsRunDir: after realpath the
   * artifact target must sit below the worktree it was found in. A symlink
   * (at the top level or one level down) whose target escapes the worktree
   * fails this check and is skipped with an audit entry.
   */
  const ownsWorktreePath = (worktreePath: string, target: string): boolean => {
    let root = resolve(worktreePath)
    let resolvedTarget = resolve(target)
    try {
      root = realpathSync(worktreePath)
      resolvedTarget = realpathSync(target)
    } catch {
      // Missing path: the lexical check below still applies.
    }
    return resolvedTarget !== root && resolvedTarget.startsWith(root + sep)
  }

  /**
   * Default du-style size estimate: iterative walk, symlinks not followed
   * (never count bytes outside the directory), deadline-checked so a huge
   * node_modules tree degrades to "unknown" instead of stalling plan().
   */
  const defaultMeasureDirectorySize = (root: string, timeoutMs: number): number | undefined => {
    const deadline = Date.now() + timeoutMs
    let total = 0
    const stack = [root]
    while (stack.length > 0) {
      if (Date.now() > deadline) return undefined
      const dir = stack.pop() as string
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          stack.push(full)
          continue
        }
        try {
          total += lstatSync(full).size
        } catch {
          // Raced with a writer; the estimate stays best-effort.
        }
      }
    }
    return total
  }
  const measureDirectorySize = deps.measureDirectorySize ?? defaultMeasureDirectorySize

  const git = async (
    context: WorkspaceContext,
    operation: string,
    args: readonly string[],
    successExitCodes: readonly number[] = [0],
  ): Promise<IpcResult<CommandResult>> => {
    const result = await deps.commands.run({
      command: 'git',
      args,
      cwd: context.repoCwd,
      runtime: context.runtime,
      timeoutMs: GIT_TIMEOUT_MS,
    })
    if (!result.ok) return result
    return successExitCodes.includes(result.data.exitCode)
      ? result
      : commandFailed(operation, result.data)
  }

  const contextFor = (workspace: Workspace): IpcResult<WorkspaceContext> => {
    const runtime = deps.resolveRuntime(workspace)
    if (!runtime.ok) return runtime
    const validated = runtime.data.validate()
    if (!validated.ok) return validated
    const policy = deps.resolvePolicy(workspace.id)
    if (!policy.ok) return policy
    return {
      ok: true,
      data: {
        workspace,
        runtime: runtime.data,
        repoCwd: runtime.data.resolveCwd(workspace.gitRoot ?? workspace.path),
        policy: policy.data,
      },
    }
  }

  /** Host-side form of a worktree directory, when the runtime can map it. */
  const hostPathFor = (context: WorkspaceContext, path: string): string | undefined => {
    const host = context.runtime.resolveHostPath(context.runtime.resolveCwd(path))
    return host.ok ? host.data : undefined
  }

  /**
   * Branch safety gate: true = the branch is gone or provably merged into the
   * base branch; false = unmerged (never deleted); error = git failed.
   */
  const branchCollectable = async (
    context: WorkspaceContext,
    worktree: Worktree,
  ): Promise<IpcResult<{ exists: boolean; merged: boolean }>> => {
    const exists = await git(
      context,
      'branch-exists',
      ['rev-parse', '--verify', '--quiet', `refs/heads/${worktree.branch}`],
      [0, 1],
    )
    if (!exists.ok) return exists
    if (exists.data.exitCode !== 0) return { ok: true, data: { exists: false, merged: false } }
    const merged = await git(
      context,
      'branch-merged',
      ['merge-base', '--is-ancestor', worktree.branch, worktree.baseBranch],
      [0, 1],
    )
    if (!merged.ok) return merged
    return { ok: true, data: { exists: true, merged: merged.data.exitCode === 0 } }
  }

  const collectWorktreeItems = async (
    context: WorkspaceContext,
    items: RetentionPlanItem[],
  ): Promise<IpcResult<void>> => {
    const listed = deps.worktrees.listByWorkspace(context.workspace.id, undefined, true)
    if (!listed.ok) return listed
    const current = now()
    for (const worktree of listed.data) {
      if (worktree.state !== 'merged' || worktree.mergedAt === undefined) continue
      const age = ageDays(current, worktree.mergedAt)
      if (age === undefined || age < context.policy.mergedWorktreeDays) continue
      // plan() runs the same branch gate as run() so the dry-run preview
      // never promises a deletion the real run would refuse.
      const branch = await branchCollectable(context, worktree)
      if (!branch.ok) return branch
      if (branch.data.exists && !branch.data.merged) {
        getLogger('runtime').warn(
          { worktreeId: worktree.id, branch: worktree.branch, baseBranch: worktree.baseBranch },
          'Retention skipped a merged-state worktree: git cannot prove the branch is merged.',
        )
        continue
      }
      const hostPath = hostPathFor(context, worktree.path)
      items.push({
        kind: 'merged-worktree',
        workspaceId: context.workspace.id,
        worktreeId: worktree.id,
        ...(worktree.runId === undefined ? {} : { runId: worktree.runId }),
        ...(hostPath === undefined ? {} : { path: hostPath }),
        ageDays: age,
        reason: `merged ${String(age)}d ago (threshold ${String(context.policy.mergedWorktreeDays)}d); directory, record${branch.data.exists ? ' and merged branch' : ''} collected`,
      })
    }
    return { ok: true, data: undefined }
  }

  const collectRunItems = (
    context: WorkspaceContext,
    items: RetentionPlanItem[],
  ): IpcResult<void> => {
    const runs = deps.runs.listByWorkspace(context.workspace.id)
    if (!runs.ok) return runs
    const current = now()
    for (const run of runs.data) {
      const logFiles = deps.paths.runLogFiles(run.runDir)
      if (LOG_COLLECTABLE_STATUSES.has(run.status)) {
        const age = ageDays(current, run.finishedAt ?? run.updatedAt)
        const hasLogs =
          pathExists(logFiles.events) ||
          pathExists(logFiles.terminal) ||
          pathExists(logFiles.progress)
        if (age !== undefined && age >= context.policy.completedRunLogsDays && hasLogs) {
          items.push({
            kind: 'run-logs',
            workspaceId: context.workspace.id,
            runId: run.id,
            path: run.runDir,
            ageDays: age,
            reason: `${run.status} run logs are ${String(age)}d old (threshold ${String(context.policy.completedRunLogsDays)}d); volatile log files collected, manifest/handoff kept`,
          })
        }
      }
      const worktree = deps.worktrees.getByRunId(run.id)
      if (!worktree.ok) return worktree
      if (worktree.data !== null && worktree.data.state === 'discarded') {
        const age = ageDays(current, worktree.data.discardedAt ?? run.updatedAt)
        if (age !== undefined && age >= context.policy.discardedRunDays) {
          items.push({
            kind: 'discarded-run',
            workspaceId: context.workspace.id,
            worktreeId: worktree.data.id,
            runId: run.id,
            path: run.runDir,
            ageDays: age,
            reason: `worktree discarded ${String(age)}d ago (threshold ${String(context.policy.discardedRunDays)}d); run directory and discarded worktree collected`,
          })
        }
      }
    }
    return { ok: true, data: undefined }
  }

  /**
   * TASK-133: true when the worktree still has a non-terminal run attached
   * (via either pointer direction). Such worktrees are never touched.
   */
  const hasActiveRun = (worktree: Worktree, runs: readonly AgentRun[]): boolean =>
    runs.some(
      (run) =>
        !TERMINAL_RUN_STATUSES.has(run.status) &&
        (run.worktreeId === worktree.id || run.id === worktree.runId),
    )

  /**
   * TASK-133 eligibility gate: terminal state (`merged` / `discarded` /
   * archived marker), or `ready` / `dirty` idle beyond
   * `worktreeArtifactIdleDays` with no live run. `conflict`, transitional
   * states (`creating` / `missing` / `orphaned`), and worktrees with a
   * non-terminal run are never eligible.
   */
  const artifactEligibility = (
    worktree: Worktree,
    policy: RetentionConfig,
    current: Date,
    activeRun: boolean,
  ): { ageDays: number; basis: string } | undefined => {
    if (worktree.state === 'conflict' || activeRun) return undefined
    if (worktree.state === 'merged' || worktree.state === 'discarded') {
      const stamp = worktree.mergedAt ?? worktree.discardedAt ?? worktree.updatedAt
      return { ageDays: ageDays(current, stamp) ?? 0, basis: worktree.state }
    }
    if (worktree.archivedAt !== undefined) {
      return { ageDays: ageDays(current, worktree.archivedAt) ?? 0, basis: 'archived' }
    }
    if (worktree.state !== 'ready' && worktree.state !== 'dirty') return undefined
    const age = ageDays(current, worktree.updatedAt)
    if (age === undefined || age < policy.worktreeArtifactIdleDays) return undefined
    return {
      ageDays: age,
      basis: `${worktree.state}, idle ${String(age)}d (threshold ${String(policy.worktreeArtifactIdleDays)}d)`,
    }
  }

  /**
   * TASK-133 name matching: top-level entries and entries of top-level
   * directories (one level down) only — no glob, no deeper descent;
   * symlinked top-level directories are matched but never descended into.
   */
  const findArtifactDirs = (worktreePath: string, patterns: readonly string[]): string[] => {
    const names = new Set(patterns)
    const matches: string[] = []
    let top
    try {
      top = readdirSync(worktreePath, { withFileTypes: true })
    } catch {
      return matches
    }
    for (const entry of top) {
      const full = join(worktreePath, entry.name)
      if (names.has(entry.name)) {
        if (entry.isDirectory() || entry.isSymbolicLink()) matches.push(full)
        continue
      }
      if (!entry.isDirectory()) continue
      let children
      try {
        children = readdirSync(full, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        if (names.has(child.name) && (child.isDirectory() || child.isSymbolicLink())) {
          matches.push(join(full, child.name))
        }
      }
    }
    return matches
  }

  /**
   * TASK-133 main-workspace guard: a worktree record whose path resolves to
   * the repository root itself is never touched, whatever its state says.
   */
  const isMainWorkspacePath = (context: WorkspaceContext, hostPath: string): boolean => {
    const repoHost = hostPathFor(context, context.workspace.gitRoot ?? context.workspace.path)
    if (repoHost === undefined) return false
    let worktreeReal = resolve(hostPath)
    let repoReal = resolve(repoHost)
    try {
      worktreeReal = realpathSync(hostPath)
      repoReal = realpathSync(repoHost)
    } catch {
      // Missing path: the lexical comparison still applies.
    }
    return worktreeReal === repoReal
  }

  const mainWorkspaceWarn = (worktreeId: string, path: string): void => {
    getLogger('runtime').warn(
      { worktreeId, path },
      'Retention skipped a worktree record pointing at the repository main working tree.',
    )
  }

  const symlinkEscapeWarn = (worktreeId: string, path: string): void => {
    getLogger('runtime').warn(
      { worktreeId, path },
      'Retention skipped a worktree artifact escaping its worktree via symlink.',
    )
  }

  const collectWorktreeArtifactItems = (
    context: WorkspaceContext,
    items: RetentionPlanItem[],
    withSizes: boolean,
  ): IpcResult<void> => {
    const listed = deps.worktrees.listByWorkspace(context.workspace.id, undefined, true)
    if (!listed.ok) return listed
    const runs = deps.runs.listByWorkspace(context.workspace.id)
    if (!runs.ok) return runs
    const current = now()
    for (const worktree of listed.data) {
      const eligible = artifactEligibility(
        worktree,
        context.policy,
        current,
        hasActiveRun(worktree, runs.data),
      )
      if (eligible === undefined) continue
      const hostPath = hostPathFor(context, worktree.path)
      if (hostPath === undefined || !pathExists(hostPath)) continue
      if (isMainWorkspacePath(context, hostPath)) {
        mainWorkspaceWarn(worktree.id, hostPath)
        continue
      }
      for (const target of findArtifactDirs(hostPath, context.policy.worktreeArtifactPatterns)) {
        // plan() applies the same ownership gate as run(): a symlink escape
        // is never listed as a deletion candidate.
        if (!ownsWorktreePath(hostPath, target)) {
          symlinkEscapeWarn(worktree.id, target)
          continue
        }
        const estimatedBytes = withSizes
          ? measureDirectorySize(target, SIZE_ESTIMATE_TIMEOUT_MS)
          : undefined
        items.push({
          kind: 'worktree-artifacts',
          workspaceId: context.workspace.id,
          worktreeId: worktree.id,
          ...(worktree.runId === undefined ? {} : { runId: worktree.runId }),
          path: target,
          ...(estimatedBytes === undefined ? {} : { estimatedBytes }),
          ageDays: eligible.ageDays,
          reason: `worktree is ${eligible.basis}; build-artifact directory ${relative(hostPath, target)} collected`,
        })
      }
    }
    return { ok: true, data: undefined }
  }

  const collect = async (
    workspaceId?: string,
    withSizes = false,
  ): Promise<IpcResult<CollectedPlan>> => {
    const policy = deps.resolvePolicy(workspaceId)
    if (!policy.ok) return policy

    let workspaceList: Workspace[]
    if (workspaceId === undefined) {
      const all = deps.workspaces.list()
      if (!all.ok) return all
      workspaceList = all.data
    } else {
      const one = deps.workspaces.getById(workspaceId)
      if (!one.ok) return one
      if (one.data === null) {
        return fail({
          code: 'WORKSPACE_NOT_FOUND',
          message: `Workspace "${workspaceId}" was not found.`,
          retryable: false,
          detail: `RetentionService could not resolve workspace id=${JSON.stringify(workspaceId)}`,
        })
      }
      workspaceList = [one.data]
    }

    const items: RetentionPlanItem[] = []
    const contexts = new Map<string, WorkspaceContext>()
    for (const workspace of workspaceList) {
      const context = contextFor(workspace)
      if (!context.ok) return context
      contexts.set(workspace.id, context.data)
      const worktreeItems = await collectWorktreeItems(context.data, items)
      if (!worktreeItems.ok) return worktreeItems
      const runItems = collectRunItems(context.data, items)
      if (!runItems.ok) return runItems
      const artifactItems = collectWorktreeArtifactItems(context.data, items, withSizes)
      if (!artifactItems.ok) return artifactItems
    }
    return { ok: true, data: { policy: policy.data, items, contexts } }
  }

  const audit = (entry: RetentionAuditEntry): RetentionAuditEntry => {
    const logger = getLogger('runtime')
    const fields = { ...entry.item, action: entry.action, detail: entry.detail }
    if (entry.action === 'failed') {
      logger.error(fields, 'Retention GC item failed.')
    } else {
      logger.info(fields, `Retention GC ${entry.action}: ${entry.item.kind}`)
    }
    return entry
  }

  type EntryResult = IpcResult<{ action: RetentionAuditEntry['action']; detail: string }>
  const okEntry = (action: RetentionAuditEntry['action'], detail: string): EntryResult => ({
    ok: true,
    data: { action, detail },
  })

  const executeMergedWorktree = async (
    context: WorkspaceContext,
    item: RetentionPlanItem,
  ): Promise<EntryResult> => {
    const worktreeId = item.worktreeId as string
    const found = deps.worktrees.getById(worktreeId)
    if (!found.ok) return found
    if (found.data === null || found.data.state !== 'merged') {
      return okEntry('skipped', 'worktree record is gone or no longer merged')
    }
    const worktree = found.data

    // The safety gate runs again at execution time: plan() may be stale.
    const branch = await branchCollectable(context, worktree)
    if (!branch.ok) return branch
    if (branch.data.exists && !branch.data.merged) {
      return okEntry(
        'skipped',
        `branch ${worktree.branch} is not merged into ${worktree.baseBranch}; unmerged branches are never deleted`,
      )
    }

    const removedParts: string[] = []
    const hostPath = hostPathFor(context, worktree.path)
    if (hostPath !== undefined && pathExists(hostPath)) {
      const removed = await git(context, 'worktree-remove', [
        'worktree',
        'remove',
        '--force',
        context.runtime.resolveCwd(worktree.path),
      ])
      if (!removed.ok) return removed
      removedParts.push('directory')
    }
    if (branch.data.exists) {
      // `git branch -d` (never -D): the is-ancestor check above passed, so a
      // failure here means git disagrees — surface it, don't force.
      const deleted = await git(context, 'branch-delete', ['branch', '-d', worktree.branch])
      if (!deleted.ok) return deleted
      removedParts.push('branch')
    }
    const deletedRecord = deps.worktrees.delete(worktree.id)
    if (!deletedRecord.ok) return deletedRecord
    removedParts.push('record')
    deps.events.emit('git.changed', { workspaceId: worktree.workspaceId })
    return okEntry('deleted', `removed ${removedParts.join(' + ')}`)
  }

  const executeRunLogs = (item: RetentionPlanItem): EntryResult => {
    const runId = item.runId as string
    const run = deps.runs.getById(runId)
    if (!run.ok) return run
    if (run.data === null) return okEntry('skipped', 'run record is gone')
    // plan() may be stale: a resumed run is live again and a process can be
    // appending to these files right now — never collect them.
    if (!LOG_COLLECTABLE_STATUSES.has(run.data.status)) {
      return okEntry('skipped', `run is ${run.data.status} again; live logs are never collected`)
    }
    if (!ownsRunDir(run.data.runDir)) {
      foreignRunDirWarn(runId, run.data.runDir)
      return okEntry(
        'skipped',
        'run directory is outside the Teskra data root; log files left untouched',
      )
    }
    const logFiles = deps.paths.runLogFiles(run.data.runDir)
    const removed: string[] = []
    try {
      for (const file of [logFiles.events, logFiles.terminal, logFiles.progress]) {
        if (pathExists(file)) {
          rmSync(file, { force: true })
          removed.push(file)
        }
      }
    } catch (cause) {
      return fail({
        code: 'UNKNOWN',
        message: 'Failed to delete run log files.',
        retryable: true,
        detail: `run log GC failed for ${run.data.runDir}`,
        cause,
      })
    }
    return removed.length === 0
      ? okEntry('skipped', 'log files already gone')
      : okEntry('deleted', `removed ${removed.map((file) => basename(file)).join(' + ')}`)
  }

  const executeDiscardedRun = async (
    context: WorkspaceContext,
    item: RetentionPlanItem,
  ): Promise<EntryResult> => {
    const runId = item.runId as string
    const run = deps.runs.getById(runId)
    if (!run.ok) return run
    if (run.data === null) return okEntry('skipped', 'run record is gone')

    const removedParts: string[] = []
    const worktree = deps.worktrees.getByRunId(runId)
    if (!worktree.ok) return worktree
    if (worktree.data !== null && worktree.data.state === 'discarded') {
      const hostPath = hostPathFor(context, worktree.data.path)
      if (hostPath !== undefined && pathExists(hostPath)) {
        // --force matches discard() semantics: the leftover was thrown away
        // by the user already. The branch is never touched here.
        const removed = await git(context, 'worktree-remove', [
          'worktree',
          'remove',
          '--force',
          context.runtime.resolveCwd(worktree.data.path),
        ])
        if (!removed.ok) return removed
        removedParts.push('worktree directory')
      }
      const deletedRecord = deps.worktrees.delete(worktree.data.id)
      if (!deletedRecord.ok) return deletedRecord
      removedParts.push('worktree record')
      deps.events.emit('git.changed', { workspaceId: worktree.data.workspaceId })
    }

    let runDirNote = ''
    if (pathExists(run.data.runDir)) {
      if (!ownsRunDir(run.data.runDir)) {
        foreignRunDirWarn(runId, run.data.runDir)
        runDirNote = '; run directory left untouched (outside the Teskra data root)'
      } else {
        try {
          rmSync(run.data.runDir, { recursive: true, force: true })
        } catch (cause) {
          return fail({
            code: 'UNKNOWN',
            message: 'Failed to delete the run directory.',
            retryable: true,
            detail: `run directory GC failed for ${run.data.runDir}`,
            cause,
          })
        }
        removedParts.push('run directory')
      }
    }

    // Handoff DB records are kept by default: they are the post-hoc audit
    // trail (ADR-0002). Only a run without one loses its agent_runs row.
    const handoff = deps.handoffs.getByRunId(runId)
    if (!handoff.ok) return handoff
    if (handoff.data === null) {
      const deletedRun = deps.runs.delete(runId)
      if (!deletedRun.ok) return deletedRun
      removedParts.push('run record')
      return okEntry('deleted', `removed ${removedParts.join(' + ')}${runDirNote}`)
    }
    return okEntry(
      'deleted',
      `removed ${removedParts.join(' + ')}; run record kept (handoff retained)${runDirNote}`,
    )
  }

  const executeWorktreeArtifacts = (
    context: WorkspaceContext,
    item: RetentionPlanItem,
  ): EntryResult => {
    const worktreeId = item.worktreeId as string
    const found = deps.worktrees.getById(worktreeId)
    if (!found.ok) return found
    if (found.data === null) return okEntry('skipped', 'worktree record is gone')
    const worktree = found.data

    // plan() may be stale: re-check the full eligibility gate at execution
    // time — a resumed run or a state flip since the plan keeps everything.
    const runs = deps.runs.listByWorkspace(context.workspace.id)
    if (!runs.ok) return runs
    const eligible = artifactEligibility(
      worktree,
      context.policy,
      now(),
      hasActiveRun(worktree, runs.data),
    )
    if (eligible === undefined) {
      return okEntry(
        'skipped',
        `worktree is ${worktree.state}${worktree.archivedAt !== undefined ? ' (archived)' : ''} with a live run or inside the idle window; artifacts left untouched`,
      )
    }
    const hostPath = hostPathFor(context, worktree.path)
    if (hostPath === undefined || !pathExists(hostPath)) {
      return okEntry('skipped', 'worktree directory is gone')
    }
    if (isMainWorkspacePath(context, hostPath)) {
      mainWorkspaceWarn(worktree.id, hostPath)
      return okEntry(
        'skipped',
        'worktree record points at the repository main working tree; artifacts left untouched',
      )
    }

    // One plan item = one directory: delete only this item's target so
    // sibling items stay meaningful (and individually auditable). Escapes
    // present at execution time are detected here and audited on this item.
    const target = item.path
    if (target === undefined) {
      return okEntry('skipped', 'no artifact path on the plan item')
    }
    const escaped = findArtifactDirs(hostPath, context.policy.worktreeArtifactPatterns)
      .filter((candidate) => !ownsWorktreePath(hostPath, candidate))
      .map((candidate) => relative(hostPath, candidate))
    for (const escapee of escaped) symlinkEscapeWarn(worktree.id, join(hostPath, escapee))
    const escapeNote = escaped.length > 0 ? `; symlink escapes skipped: ${escaped.join(' + ')}` : ''

    if (!ownsWorktreePath(hostPath, target)) {
      // The plan was clean but the path was swapped for a symlink meanwhile.
      symlinkEscapeWarn(worktree.id, target)
      return okEntry(
        'skipped',
        `artifact path escapes its worktree via symlink; left untouched${escapeNote}`,
      )
    }
    if (!pathExists(target)) {
      return okEntry('skipped', `artifact directory already gone${escapeNote}`)
    }
    try {
      rmSync(target, { recursive: true, force: true })
    } catch (cause) {
      return fail({
        code: 'UNKNOWN',
        message: 'Failed to delete worktree build artifacts.',
        retryable: true,
        detail: `worktree artifact GC failed for ${target}`,
        cause,
      })
    }
    return okEntry('deleted', `removed ${relative(hostPath, target)}${escapeNote}`)
  }

  const executeItem = async (
    contexts: ReadonlyMap<string, WorkspaceContext>,
    item: RetentionPlanItem,
  ): Promise<EntryResult> => {
    const context = contexts.get(item.workspaceId)
    if (context === undefined) {
      return fail({
        code: 'WORKSPACE_NOT_FOUND',
        message: 'The workspace of this retention item is unavailable.',
        retryable: false,
        detail: `no context for workspace=${item.workspaceId}`,
      })
    }
    switch (item.kind) {
      case 'merged-worktree':
        return executeMergedWorktree(context, item)
      case 'run-logs':
        return executeRunLogs(item)
      case 'discarded-run':
        return executeDiscardedRun(context, item)
      case 'worktree-artifacts':
        return executeWorktreeArtifacts(context, item)
      default:
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Unknown retention item kind.',
          retryable: false,
          detail: `kind=${JSON.stringify(item.kind)}`,
        })
    }
  }

  const executeRun = async (
    request: RetentionRunRequest,
    signal?: AbortSignal,
  ): Promise<IpcResult<RetentionReport>> => {
    // The guard must be set synchronously, before the first await —
    // otherwise a concurrent run() slips through the check in run() while
    // this one is suspended in collect().
    const controller = new AbortController()
    active = controller
    const abortFromCaller = (): void => controller.abort()
    if (signal !== undefined) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', abortFromCaller, { once: true })
    }
    try {
      const startedAt = now().toISOString()
      const collected = await collect(request.workspaceId)
      if (!collected.ok) return collected
      const { policy, items, contexts } = collected.data

      const entries: RetentionAuditEntry[] = []
      let cancelled = false
      const dryRun = request.dryRun === true
      for (const item of items) {
        deps.onItemStart?.(item)
        if (controller.signal.aborted) {
          cancelled = true
          entries.push(
            audit({
              item,
              action: 'skipped',
              detail: 'cancelled before this item',
              at: now().toISOString(),
            }),
          )
          continue
        }
        if (dryRun) {
          entries.push(
            audit({ item, action: 'skipped', detail: 'dry-run', at: now().toISOString() }),
          )
          continue
        }
        const executed = await executeItem(contexts, item)
        if (!executed.ok) {
          entries.push(
            audit({
              item,
              action: 'failed',
              detail: executed.error.message,
              at: now().toISOString(),
            }),
          )
          continue
        }
        entries.push(
          audit({
            item,
            action: executed.data.action,
            detail: executed.data.detail,
            at: now().toISOString(),
          }),
        )
      }
      return {
        ok: true,
        data: {
          startedAt,
          finishedAt: now().toISOString(),
          dryRun: request.dryRun === true,
          cancelled,
          policy,
          entries,
        },
      }
    } finally {
      active = null
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  return {
    async plan(request = {}) {
      // plan() is the preview: it pays for du-style size estimates; run()
      // re-collects without them so deletion is never delayed by measuring.
      const collected = await collect(request.workspaceId, true)
      if (!collected.ok) return collected
      return {
        ok: true,
        data: {
          generatedAt: now().toISOString(),
          policy: collected.data.policy,
          items: collected.data.items,
        },
      }
    },

    run(request = {}, signal) {
      if (active !== null) {
        return Promise.resolve(
          fail<RetentionReport>({
            code: 'UNKNOWN',
            message: 'A retention run is already in progress.',
            retryable: true,
            detail: 'RetentionService.run called while another run is active',
          }),
        )
      }
      const promise = executeRun(request, signal)
      activeRun = promise
      const clear = (): void => {
        if (activeRun === promise) activeRun = null
      }
      void promise.then(clear, clear)
      return promise
    },

    cancel() {
      if (active === null) return { ok: true, data: false }
      active.abort()
      return { ok: true, data: true }
    },

    async dispose() {
      const inFlight = activeRun
      if (inFlight === null) return
      active?.abort()
      await inFlight.then(
        () => undefined,
        () => undefined,
      )
    },
  }
}
