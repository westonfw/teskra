import { existsSync, rmSync } from 'node:fs'

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
 *
 * Guarantees pinned by tests: plan() never mutates; run() checks the abort
 * signal between items (cancellation leaves unprocessed items untouched);
 * every processed item yields an audit entry (what / why / when), mirrored
 * to the structured log. No new DB table — the report plus the log are the
 * audit trail.
 */

const GIT_TIMEOUT_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000

/** Runs eligible for log GC: nothing a live process could still append to. */
const LOG_COLLECTABLE_STATUSES = new Set<AgentRun['status']>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

export interface RetentionService {
  plan(request?: RetentionPlanRequest): Promise<IpcResult<RetentionPlan>>
  run(request?: RetentionRunRequest, signal?: AbortSignal): Promise<IpcResult<RetentionReport>>
  /** Aborts the in-flight run between items; false when nothing was running. */
  cancel(): IpcResult<boolean>
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
        const hasLogs = pathExists(logFiles.events) || pathExists(logFiles.terminal)
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

  const collect = async (workspaceId?: string): Promise<IpcResult<CollectedPlan>> => {
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
    const logFiles = deps.paths.runLogFiles(run.data.runDir)
    const removed: string[] = []
    try {
      for (const file of [logFiles.events, logFiles.terminal]) {
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
      : okEntry('deleted', `removed ${removed.map((file) => file.split('/').pop()).join(' + ')}`)
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

    if (pathExists(run.data.runDir)) {
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

    // Handoff DB records are kept by default: they are the post-hoc audit
    // trail (ADR-0002). Only a run without one loses its agent_runs row.
    const handoff = deps.handoffs.getByRunId(runId)
    if (!handoff.ok) return handoff
    if (handoff.data === null) {
      const deletedRun = deps.runs.delete(runId)
      if (!deletedRun.ok) return deletedRun
      removedParts.push('run record')
      return okEntry('deleted', `removed ${removedParts.join(' + ')}`)
    }
    return okEntry(
      'deleted',
      `removed ${removedParts.join(' + ')}; run record kept (handoff retained)`,
    )
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
      default:
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Unknown retention item kind.',
          retryable: false,
          detail: `kind=${JSON.stringify(item.kind)}`,
        })
    }
  }

  return {
    async plan(request = {}) {
      const collected = await collect(request.workspaceId)
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

    async run(request = {}, signal) {
      if (active !== null) {
        return fail({
          code: 'UNKNOWN',
          message: 'A retention run is already in progress.',
          retryable: true,
          detail: 'RetentionService.run called while another run is active',
        })
      }
      const startedAt = now().toISOString()
      const collected = await collect(request.workspaceId)
      if (!collected.ok) return collected
      const { policy, items, contexts } = collected.data

      const controller = new AbortController()
      const abortFromCaller = (): void => controller.abort()
      if (signal !== undefined) {
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', abortFromCaller, { once: true })
      }
      active = controller
      const entries: RetentionAuditEntry[] = []
      let cancelled = false
      try {
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
      } finally {
        active = null
        signal?.removeEventListener('abort', abortFromCaller)
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
    },

    cancel() {
      if (active === null) return { ok: true, data: false }
      active.abort()
      return { ok: true, data: true }
    },
  }
}
