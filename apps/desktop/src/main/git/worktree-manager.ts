import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type {
  IpcResult,
  WorkbenchEvents,
  Workspace,
  WorktreeCleanupRequest,
  WorktreeCleanupResult,
  WorktreeCreateRequest,
  WorktreeDiscardRequest,
  WorktreeIdRequest,
  WorktreeListRequest,
} from '@teskra/contracts'

import type { Worktree, WorktreeRepository } from '../db/repositories/worktree-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { TESKRA_DATA_DIR } from '../paths'
import type { CommandResult, CommandRunner } from '../process/command-runner'
import type { WorkspaceRuntime } from '../workspace/runtime'

/**
 * WorktreeManager (TASK-043, teskra-tasks.md; ADR-0003).
 *
 * Owns the git-worktree lifecycle for Agent runs. All git primitives are
 * delegated to CommandRunner (never a direct spawn); GitManager's public
 * interface is left untouched — worktree git commands need a different cwd
 * anchor (the main repository for `git worktree add/remove`, the worktree
 * itself for status probes), so they live here with the same runtime/cwd
 * resolution as GitManager.
 *
 * Lifecycle verbs are deliberately separated (TASK-047), never one ambiguous
 * "remove":
 *
 * - Cancel: NOT here — AgentManager.cancel stops the process only and never
 *   touches the worktree, branch, or files.
 * - discard(): throws away the worktree and its uncommitted changes. Requires
 *   an explicit `confirm: true` at the IPC boundary. The agent branch is kept
 *   by default; `deleteBranch: true` deletes it only when already merged into
 *   the base branch — unmerged branches are never deleted.
 * - archive(): writes only the `archived_at` DB marker; git state is
 *   untouched and list() hides archived records unless `includeArchived`.
 * - cleanup(): batch-removes only safe leftovers — missing/orphaned records
 *   (after `git worktree prune`) and leftover directories of merged/discarded
 *   worktrees. Active states (creating/ready/dirty/conflict) and branches are
 *   never touched.
 *
 * Naming and placement (ADR-0003, pinned by tests):
 *
 * - Branch: `agent/<taskId>/<agentId>/<runId>`; when the run has no task the
 *   fixed fallback is `agent/<runId>` (keeps the `agent/` prefix consistent).
 * - Directory: `<runtime.resolveDataRoot()>/worktrees/<workspaceId>/<runId>/`.
 *   WSL workspaces therefore keep worktrees inside the WSL filesystem, never
 *   next to the repository (`../.agent-worktrees/` is the superseded plan §36
 *   layout).
 * - After creation the repository's `.git/info/exclude` (NOT the user's
 *   `.gitignore`) gains `.teskra/handoff/` and `.teskra/artifacts/` so Agent
 *   handoff/artifact output cannot pollute diffs (ADR-0004). The append is
 *   idempotent.
 */

const GIT_TIMEOUT_MS = 60_000

/** Runtime artifact directories excluded via .git/info/exclude (ADR-0004). */
const EXCLUDE_ENTRIES = [`${TESKRA_DATA_DIR}/handoff/`, `${TESKRA_DATA_DIR}/artifacts/`] as const

/** States validate() is allowed to rewrite; terminal/conflict states stick. */
const VALIDATABLE_STATES = new Set<Worktree['state']>(['creating', 'ready', 'dirty'])

export interface WorktreeManager {
  create(request: WorktreeCreateRequest): Promise<IpcResult<Worktree>>
  list(request: WorktreeListRequest): Promise<IpcResult<Worktree[]>>
  validate(request: WorktreeIdRequest): Promise<IpcResult<Worktree>>
  discard(request: WorktreeDiscardRequest): Promise<IpcResult<Worktree>>
  archive(request: WorktreeIdRequest): Promise<IpcResult<Worktree>>
  cleanup(request: WorktreeCleanupRequest): Promise<IpcResult<WorktreeCleanupResult>>
}

export interface WorktreeManagerDeps {
  readonly commands: CommandRunner
  readonly workspaces: WorkspaceRepository
  readonly worktrees: WorktreeRepository
  readonly events: EventBus<WorkbenchEvents>
  readonly resolveRuntime: (workspace: Workspace) => IpcResult<WorkspaceRuntime>
  readonly createWorktreeId?: () => string
  /** Filesystem probe; defaults to node:fs existsSync (host-side paths). */
  readonly pathExists?: (path: string) => boolean
  readonly now?: () => string
}

interface WorktreeContext {
  readonly workspace: Workspace
  readonly runtime: WorkspaceRuntime
  /** Main repository cwd, runtime-side form. */
  readonly repoCwd: string
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

function missingWorktree<T>(id: string): IpcResult<T> {
  return fail({
    code: 'VALIDATION_FAILED',
    message: `Worktree "${id}" was not found.`,
    messageKey: 'errorMessage.worktreeNotFound',
    params: { id },
    retryable: false,
    detail: `WorktreeManager could not resolve worktree id=${JSON.stringify(id)}`,
  })
}

/**
 * Branch/directory segments must be a single safe path component: no
 * separators, no `..`, no git-ref forbidden characters.
 */
function isValidSegment(value: string): boolean {
  return value.length > 0 && !/[~/\\^:?*[\]]|\.\.|\s/u.test(value) && !value.startsWith('.')
}

function invalidSegment<T>(kind: string, value: string): IpcResult<T> {
  return fail({
    code: 'VALIDATION_FAILED',
    message: `Invalid ${kind} for a worktree.`,
    messageKey: 'errorMessage.invalidWorktreeSegment',
    params: { kind },
    retryable: false,
    detail: `${kind} must be a single safe path/ref segment, got ${JSON.stringify(value)}`,
  })
}

/** TASK-043 branch naming; see module docstring for the fixed fallback. */
export function worktreeBranchName(request: WorktreeCreateRequest): string {
  return request.taskId !== undefined && request.agentId !== undefined
    ? `agent/${request.taskId}/${request.agentId}/${request.runId}`
    : `agent/${request.runId}`
}

/** Lines guaranteed present, terminated, without duplicating existing ones. */
export function mergeExcludeEntries(content: string): string {
  const lines = content.split('\n').map((line) => line.trim())
  const missing = EXCLUDE_ENTRIES.filter((entry) => !lines.includes(entry))
  if (missing.length === 0) return content
  const prefix = content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content
  return `${prefix}${missing.join('\n')}\n`
}

export function createWorktreeManager(deps: WorktreeManagerDeps): WorktreeManager {
  const pathExists = deps.pathExists ?? existsSync
  const now = deps.now ?? (() => new Date().toISOString())

  const contextFor = (workspaceId: string): IpcResult<WorktreeContext> => {
    const workspace = deps.workspaces.getById(workspaceId)
    if (!workspace.ok) return workspace
    if (workspace.data === null) {
      return fail({
        code: 'WORKSPACE_NOT_FOUND',
        message: `Workspace "${workspaceId}" was not found.`,
        messageKey: 'errorMessage.workspaceNotFound',
        params: { id: workspaceId },
        retryable: false,
        detail: `WorktreeManager could not resolve workspace id=${JSON.stringify(workspaceId)}`,
      })
    }
    const runtime = deps.resolveRuntime(workspace.data)
    if (!runtime.ok) return runtime
    const validated = runtime.data.validate()
    if (!validated.ok) return validated
    return {
      ok: true,
      data: {
        workspace: workspace.data,
        runtime: runtime.data,
        repoCwd: runtime.data.resolveCwd(workspace.data.gitRoot ?? workspace.data.path),
      },
    }
  }

  const git = async (
    context: WorktreeContext,
    operation: string,
    args: readonly string[],
    cwd = context.repoCwd,
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

  /** ADR-0003: worktree directory inside THIS runtime's data root. */
  const worktreePathFor = (runtime: WorkspaceRuntime, workspaceId: string, runId: string): string =>
    runtime.resolveCwd(`${runtime.resolveDataRoot()}/worktrees/${workspaceId}/${runId}`)

  const hostPathFor = (runtime: WorkspaceRuntime, runtimePath: string): IpcResult<string> =>
    runtime.resolveHostPath(runtime.resolveCwd(runtimePath))

  /** Idempotent .git/info/exclude append; returns the host/runtime path used. */
  const ensureExcludeEntries = async (context: WorktreeContext): Promise<IpcResult<string>> => {
    if (context.runtime.hostNative) {
      const located = await git(context, 'rev-parse', ['rev-parse', '--git-path', 'info/exclude'])
      if (!located.ok) return located
      const raw = located.data.stdout.trim()
      const runtimePath = context.runtime.resolveCwd(
        raw.startsWith('/') || /^[A-Za-z]:/u.test(raw) ? raw : `${context.repoCwd}/${raw}`,
      )
      const hostPath = context.runtime.resolveHostPath(runtimePath)
      if (!hostPath.ok) return hostPath
      try {
        const current = pathExists(hostPath.data) ? readFileSync(hostPath.data, 'utf8') : ''
        const merged = mergeExcludeEntries(current)
        if (merged !== current) {
          mkdirSync(dirname(hostPath.data), { recursive: true })
          writeFileSync(hostPath.data, merged)
        }
        return { ok: true, data: runtimePath }
      } catch (cause) {
        return fail({
          code: 'UNKNOWN',
          message: 'Failed to update .git/info/exclude.',
          retryable: true,
          detail: `exclude path=${hostPath.data}`,
          cause,
        })
      }
    }
    // Non-host-native runtime (WSL from a Windows host): the file lives inside
    // the runtime filesystem, so append through a shell inside the runtime.
    const script = [
      'set -e',
      'exclude="$(git rev-parse --git-path info/exclude)"',
      'mkdir -p "$(dirname "$exclude")"',
      'touch "$exclude"',
      ...EXCLUDE_ENTRIES.map(
        (entry) => `grep -qxF '${entry}' "$exclude" || printf '%s\\n' '${entry}' >> "$exclude"`,
      ),
    ].join('\n')
    const appended = await deps.commands.run({
      command: 'bash',
      args: ['-c', script],
      cwd: context.repoCwd,
      runtime: context.runtime,
      timeoutMs: GIT_TIMEOUT_MS,
    })
    if (!appended.ok) return appended
    return appended.data.exitCode === 0
      ? { ok: true, data: '.git/info/exclude' }
      : commandFailed('exclude-update', appended.data)
  }

  const detectBaseBranch = async (context: WorktreeContext): Promise<IpcResult<string>> => {
    const current = await git(context, 'branch', ['branch', '--show-current'])
    if (!current.ok) return current
    const branch = current.data.stdout.trim()
    return branch.length > 0
      ? { ok: true, data: branch }
      : fail({
          code: 'VALIDATION_FAILED',
          message: 'The repository is on a detached HEAD; pass baseBranch explicitly.',
          messageKey: 'errorMessage.detachedHead',
          retryable: false,
          detail: `WorktreeManager could not detect a base branch in ${context.repoCwd}`,
        })
  }

  return {
    async create(request) {
      for (const [kind, value] of [
        ['runId', request.runId],
        ['taskId', request.taskId],
        ['agentId', request.agentId],
        ['workspaceId', request.workspaceId],
      ] as const) {
        if (value !== undefined && !isValidSegment(value)) return invalidSegment(kind, value)
      }
      const context = contextFor(request.workspaceId)
      if (!context.ok) return context

      const duplicate = deps.worktrees.getByRunId(request.runId)
      if (!duplicate.ok) return duplicate
      if (duplicate.data !== null) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `A worktree already exists for run "${request.runId}".`,
          messageKey: 'errorMessage.worktreeExistsForRun',
          params: { runId: request.runId },
          retryable: false,
          detail: `worktree id=${duplicate.data.id} already points at run=${request.runId}`,
        })
      }

      const branch = worktreeBranchName(request)
      const path = worktreePathFor(context.data.runtime, request.workspaceId, request.runId)
      const base =
        request.baseBranch === undefined
          ? await detectBaseBranch(context.data)
          : { ok: true as const, data: request.baseBranch }
      if (!base.ok) return base

      const created = deps.worktrees.create(
        {
          id: deps.createWorktreeId?.() ?? randomUUID(),
          workspaceId: request.workspaceId,
          runId: request.runId,
          branch,
          baseBranch: base.data,
          path,
          isolation: request.isolation ?? 'worktree',
        },
        now(),
      )
      if (!created.ok) return created
      const worktreeId = created.data.id

      // Failure cleanup: drop the half-created worktree and its record so the
      // runId stays reusable and Reconciliation sees no phantom intent. When
      // `worktree add` succeeded, the branch it created must go too — a
      // leftover branch makes every retry fail with "branch already exists".
      // The branch is only deleted when this call created it (never when
      // `worktree add` itself failed, e.g. on a pre-existing branch).
      const rollback = async (deleteCreatedBranch: boolean): Promise<void> => {
        await git(context.data, 'worktree-remove', ['worktree', 'remove', '--force', path])
        if (deleteCreatedBranch) {
          await git(context.data, 'branch-delete', ['branch', '-D', branch])
        }
        deps.worktrees.delete(worktreeId)
      }

      const added = await git(context.data, 'worktree-add', [
        'worktree',
        'add',
        '-b',
        branch,
        path,
        base.data,
      ])
      if (!added.ok) {
        await rollback(false)
        return added
      }

      const excluded = await ensureExcludeEntries(context.data)
      if (!excluded.ok) {
        await rollback(true)
        return excluded
      }

      const ready = deps.worktrees.updateState(worktreeId, 'ready', now())
      if (!ready.ok) return ready
      if (ready.data === null) return missingWorktree(worktreeId)
      deps.events.emit('git.changed', { workspaceId: request.workspaceId })
      return { ok: true, data: ready.data }
    },

    list(request) {
      const workspace = deps.workspaces.getById(request.workspaceId)
      if (!workspace.ok) return Promise.resolve(workspace)
      if (workspace.data === null) {
        return Promise.resolve(
          fail({
            code: 'WORKSPACE_NOT_FOUND',
            message: `Workspace "${request.workspaceId}" was not found.`,
            messageKey: 'errorMessage.workspaceNotFound',
            params: { id: request.workspaceId },
            retryable: false,
            detail: `WorktreeManager could not resolve workspace id=${JSON.stringify(request.workspaceId)}`,
          }),
        )
      }
      return Promise.resolve(
        deps.worktrees.listByWorkspace(
          request.workspaceId,
          request.state,
          request.includeArchived === true,
        ),
      )
    },

    async validate({ worktreeId }) {
      const found = deps.worktrees.getById(worktreeId)
      if (!found.ok) return found
      if (found.data === null) return missingWorktree(worktreeId)
      const record = found.data
      if (!VALIDATABLE_STATES.has(record.state)) return { ok: true, data: record }

      const context = contextFor(record.workspaceId)
      if (!context.ok) return context

      const settle = (state: Worktree['state']): IpcResult<Worktree> => {
        if (state === record.state) return { ok: true, data: record }
        const updated = deps.worktrees.updateState(record.id, state, now())
        if (!updated.ok) return updated
        return updated.data === null ? missingWorktree(record.id) : { ok: true, data: updated.data }
      }

      const hostPath = hostPathFor(context.data.runtime, record.path)
      const exists = hostPath.ok && pathExists(hostPath.data)
      if (!exists) return settle('missing')

      const worktreeCwd = context.data.runtime.resolveCwd(record.path)
      const inside = await git(
        context.data,
        'rev-parse',
        ['rev-parse', '--is-inside-work-tree'],
        worktreeCwd,
        [0, 1, 128],
      )
      if (!inside.ok) return inside
      if (inside.data.exitCode !== 0 || inside.data.stdout.trim() !== 'true') {
        return settle('orphaned')
      }

      const status = await git(
        context.data,
        'status',
        [
          'status',
          '--porcelain',
          '--',
          '.',
          ':(exclude)node_modules',
          ':(exclude)**/node_modules/**',
        ],
        worktreeCwd,
      )
      if (!status.ok) return status
      return settle(status.data.stdout.trim().length === 0 ? 'ready' : 'dirty')
    },

    async discard({ worktreeId, confirm, deleteBranch }) {
      // TASK-047: discarding throws away uncommitted Agent output, so the IPC
      // boundary requires an explicit confirmation flag.
      if (confirm !== true) {
        return fail({
          code: 'VALIDATION_FAILED',
          message:
            'Discarding a worktree permanently deletes its uncommitted changes; rerun with confirm: true to proceed.',
          messageKey: 'errorMessage.worktreeDiscardNeedsConfirm',
          retryable: false,
          detail: `discard(${JSON.stringify(worktreeId)}) called without confirm: true`,
        })
      }
      const found = deps.worktrees.getById(worktreeId)
      if (!found.ok) return found
      if (found.data === null) return missingWorktree(worktreeId)
      const record = found.data

      const context = contextFor(record.workspaceId)
      if (!context.ok) return context

      // Branch policy is checked BEFORE anything is torn down: an unmerged
      // branch is never deleted, and refusing fails the whole call so no
      // partial state is left behind.
      let branchExists = false
      if (deleteBranch === true) {
        const branchRef = `refs/heads/${record.branch}`
        const exists = await git(
          context.data,
          'branch-exists',
          ['rev-parse', '--verify', '--quiet', branchRef],
          context.data.repoCwd,
          [0, 1],
        )
        if (!exists.ok) return exists
        branchExists = exists.data.exitCode === 0
        if (branchExists) {
          const merged = await git(
            context.data,
            'branch-merged',
            ['merge-base', '--is-ancestor', record.branch, record.baseBranch],
            context.data.repoCwd,
            [0, 1],
          )
          if (!merged.ok) return merged
          if (merged.data.exitCode !== 0) {
            return fail({
              code: 'VALIDATION_FAILED',
              message: `Branch "${record.branch}" is not merged into "${record.baseBranch}"; unmerged branches are never deleted. Discard without deleteBranch to keep it.`,
              messageKey: 'errorMessage.branchNotMergedDelete',
              params: { branch: record.branch, baseBranch: record.baseBranch },
              retryable: false,
              detail: `refused deleteBranch for unmerged branch=${record.branch} base=${record.baseBranch}`,
            })
          }
        }
      }

      if (record.state !== 'discarded') {
        const hostPath = hostPathFor(context.data.runtime, record.path)
        const exists = hostPath.ok && pathExists(hostPath.data)
        if (exists) {
          // --force: discarding a worktree intentionally throws away
          // uncommitted Agent output; the branch (and its commits) is kept
          // unless the merged check above cleared it for deletion.
          const removed = await git(context.data, 'worktree-remove', [
            'worktree',
            'remove',
            '--force',
            context.data.runtime.resolveCwd(record.path),
          ])
          if (!removed.ok) return removed
        } else {
          // Directory already gone: clear stale administrative files best-effort.
          await git(context.data, 'worktree-prune', ['worktree', 'prune'])
        }
      }

      if (deleteBranch === true && branchExists) {
        // `git branch -d` (never -D): the merged check above already passed,
        // so a failure here means git disagrees — surface it, don't force.
        const deleted = await git(context.data, 'branch-delete', ['branch', '-d', record.branch])
        if (!deleted.ok) return deleted
      }

      if (record.state === 'discarded') return { ok: true, data: record }
      const updated = deps.worktrees.update(
        record.id,
        { state: 'discarded', discardedAt: now() },
        now(),
      )
      if (!updated.ok) return updated
      if (updated.data === null) return missingWorktree(record.id)
      deps.events.emit('git.changed', { workspaceId: record.workspaceId })
      return { ok: true, data: updated.data }
    },

    archive({ worktreeId }) {
      // TASK-047: archive writes only the DB marker — no git state changes, no
      // state-machine transition; list() hides the record by default.
      const found = deps.worktrees.getById(worktreeId)
      if (!found.ok) return Promise.resolve(found)
      if (found.data === null) return Promise.resolve(missingWorktree(worktreeId))
      if (found.data.archivedAt !== undefined) {
        return Promise.resolve({ ok: true, data: found.data })
      }
      const updated = deps.worktrees.update(worktreeId, { archivedAt: now() }, now())
      if (!updated.ok) return Promise.resolve(updated)
      return Promise.resolve(
        updated.data === null ? missingWorktree(worktreeId) : { ok: true, data: updated.data },
      )
    },

    async cleanup({ workspaceId }) {
      // TASK-047: cleanup removes only safe leftovers. It never touches
      // active states (creating/ready/dirty/conflict), never deletes branches,
      // and never deletes an orphaned directory (it may hold Agent output that
      // lost its git metadata — only discard() with confirm may destroy that).
      const context = contextFor(workspaceId)
      if (!context.ok) return context

      const listed = deps.worktrees.listByWorkspace(workspaceId, undefined, true)
      if (!listed.ok) return listed

      const prunedRecordIds: string[] = []
      const removedDirectoryIds: string[] = []
      const skippedIds: string[] = []
      let pruned = false

      for (const record of listed.data) {
        if (record.state === 'missing' || record.state === 'orphaned') {
          if (!pruned) {
            const prune = await git(context.data, 'worktree-prune', ['worktree', 'prune'])
            if (!prune.ok) return prune
            pruned = true
          }
          const deleted = deps.worktrees.delete(record.id)
          if (!deleted.ok) return deleted
          prunedRecordIds.push(record.id)
          continue
        }
        if (record.state === 'merged' || record.state === 'discarded') {
          const hostPath = hostPathFor(context.data.runtime, record.path)
          const exists = hostPath.ok && pathExists(hostPath.data)
          if (exists) {
            const removed = await git(context.data, 'worktree-remove', [
              'worktree',
              'remove',
              '--force',
              context.data.runtime.resolveCwd(record.path),
            ])
            if (!removed.ok) return removed
            removedDirectoryIds.push(record.id)
          }
          continue
        }
        skippedIds.push(record.id)
      }

      if (prunedRecordIds.length > 0 || removedDirectoryIds.length > 0) {
        deps.events.emit('git.changed', { workspaceId })
      }
      return { ok: true, data: { workspaceId, prunedRecordIds, removedDirectoryIds, skippedIds } }
    },
  }
}
