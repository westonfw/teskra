import type {
  GitBranch,
  GitCommit,
  GitCommitRequest,
  GitCommitResult,
  GitDiffRequest,
  GitLogRequest,
  GitOpenFileRequest,
  GitRawDiff,
  GitStatus,
  IpcResult,
  WorkbenchEvents,
  Workspace,
} from '@teskra/contracts'

import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import type { CommandResult, CommandRunner } from '../process/command-runner'
import type { WorkspaceRuntime } from '../workspace/runtime'

const READ_TIMEOUT_MS = 15_000
const COMMIT_TIMEOUT_MS = 60_000

/**
 * TASK-063: branch-vs-branch diff (default full workflow summary). Refs are
 * validated against a strict charset and passed as one `base...head`
 * rev-range argument, so neither ref can be read as a command option.
 */
export interface GitDiffRefsRequest {
  readonly workspaceId: string
  readonly baseRef: string
  readonly headRef: string
}

const VALID_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u

/**
 * Batch line stats for one `git diff --numstat` run (P1-5). Binary files show
 * `-` in numstat output and surface as 0/0.
 */
export interface GitNumstatEntry {
  readonly path: string
  readonly additions: number
  readonly deletions: number
}

export interface GitManager {
  status(workspaceId: string): Promise<IpcResult<GitStatus>>
  branch(workspaceId: string): Promise<IpcResult<GitBranch>>
  diff(request: GitDiffRequest): Promise<IpcResult<GitRawDiff>>
  /** Main-internal (TASK-063): `git diff <baseRef>...<headRef>` raw patch. */
  diffRefs(request: GitDiffRefsRequest): Promise<IpcResult<GitRawDiff>>
  /** Main-internal (P1-5): per-file line stats of the whole diff in one spawn. */
  diffNumstat(request: GitDiffRequest): Promise<IpcResult<readonly GitNumstatEntry[]>>
  log(request: GitLogRequest): Promise<IpcResult<GitCommit[]>>
  commit(request: GitCommitRequest): Promise<IpcResult<GitCommitResult>>
  openFile(request: GitOpenFileRequest): Promise<IpcResult<void>>
  /** Internal DiffService primitive for files not yet tracked by Git. */
  untrackedDiff(workspaceId: string, path: string): Promise<IpcResult<GitRawDiff>>
  /** Internal DiffService primitive: line stats of one untracked file. */
  untrackedNumstat(workspaceId: string, path: string): Promise<IpcResult<GitNumstatEntry>>
}

export interface GitManagerDeps {
  readonly commands: CommandRunner
  readonly workspaces: WorkspaceRepository
  readonly events: EventBus<WorkbenchEvents>
  readonly resolveRuntime: (workspace: Workspace) => IpcResult<WorkspaceRuntime>
  readonly openPath?: ((path: string) => Promise<string>) | undefined
}

interface GitContext {
  readonly workspace: Workspace
  readonly runtime: WorkspaceRuntime
  readonly cwd: string
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

function parseStatus(output: string): GitStatus {
  let branch: string | undefined
  let upstream: string | undefined
  let ahead = 0
  let behind = 0
  const entries: GitStatus['entries'] = []
  const records = output
    .split('\0')
    .flatMap((record) => (record.startsWith('#') ? record.split('\n') : [record]))
    .filter(Boolean)

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string
    if (record.startsWith('# branch.head ')) {
      const name = record.slice('# branch.head '.length)
      branch = name === '(detached)' ? undefined : name
    } else if (record.startsWith('# branch.upstream ')) {
      upstream = record.slice('# branch.upstream '.length)
    } else if (record.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)$/u.exec(record)
      ahead = Number(match?.[1] ?? 0)
      behind = Number(match?.[2] ?? 0)
    } else if (record.startsWith('1 ')) {
      entries.push({ code: record.slice(2, 4), path: restAfterFields(record, 8) })
    } else if (record.startsWith('2 ')) {
      entries.push({ code: record.slice(2, 4), path: restAfterFields(record, 9) })
      index += 1 // porcelain v2 -z emits the rename source as the next record
    } else if (record.startsWith('u ')) {
      entries.push({ code: record.slice(2, 4), path: restAfterFields(record, 10) })
    } else if (record.startsWith('? ')) {
      entries.push({ code: '??', path: record.slice(2) })
    }
  }

  return { branch, upstream, ahead, behind, clean: entries.length === 0, entries }
}

function restAfterFields(record: string, count: number): string {
  let position = 0
  for (let field = 0; field < count; field += 1) {
    position = record.indexOf(' ', position)
    if (position < 0) return ''
    position += 1
  }
  return record.slice(position)
}

/**
 * Parses `git diff --numstat -z` output. Records are NUL-separated
 * `added\tdeleted\tpath`; a rename (or a `--no-index /dev/null <path>` pair)
 * leaves the path field empty and follows with two NUL-separated paths —
 * old then new — and the entry is keyed by the new path, matching how
 * `status --porcelain=v2` reports renames.
 */
function parseNumstat(output: string): GitNumstatEntry[] {
  const tokens = output.split('\0')
  const entries: GitNumstatEntry[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string
    if (token === '') continue
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/u.exec(token)
    if (match === null) continue
    const additions = match[1] === '-' ? 0 : Number(match[1])
    const deletions = match[2] === '-' ? 0 : Number(match[2])
    let path = match[3] as string
    if (path === '') {
      const newPath = tokens[index + 2]
      index += 2
      if (newPath === undefined || newPath === '') continue
      path = newPath
    }
    entries.push({ path, additions, deletions })
  }
  return entries
}

function parseLog(output: string): GitCommit[] {
  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .flatMap((record) => {
      const [hash, shortHash, author, authoredAt, subject] = record.split('\x1f')
      return hash !== undefined &&
        shortHash !== undefined &&
        author !== undefined &&
        authoredAt !== undefined &&
        subject !== undefined
        ? [{ hash, shortHash, author, authoredAt, subject }]
        : []
    })
}

function validRelativePath(path: string): boolean {
  return (
    !path.startsWith('/') &&
    !path.startsWith('\\') &&
    !/^[A-Za-z]:/u.test(path) &&
    !path.split(/[\\/]/u).includes('..')
  )
}

/** TASK-035 Git authority; every bounded command is delegated to CommandRunner. */
export function createGitManager(deps: GitManagerDeps): GitManager {
  const statusInFlight = new Map<string, Promise<IpcResult<GitStatus>>>()
  const contextFor = (workspaceId: string): IpcResult<GitContext> => {
    const workspace = deps.workspaces.getById(workspaceId)
    if (!workspace.ok) return workspace
    if (workspace.data === null) {
      return fail({
        code: 'WORKSPACE_NOT_FOUND',
        message: `Workspace "${workspaceId}" was not found.`,
        messageKey: 'errorMessage.workspaceNotFound',
        params: { id: workspaceId },
        retryable: false,
        detail: `GitManager could not resolve workspace id=${JSON.stringify(workspaceId)}`,
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
        cwd: runtime.data.resolveCwd(workspace.data.gitRoot ?? workspace.data.path),
      },
    }
  }

  const run = async (
    workspaceId: string,
    operation: string,
    args: readonly string[],
    timeoutMs = READ_TIMEOUT_MS,
    successExitCodes: readonly number[] = [0],
  ): Promise<IpcResult<CommandResult>> => {
    const context = contextFor(workspaceId)
    if (!context.ok) return context
    const result = await deps.commands.run({
      command: 'git',
      args,
      cwd: context.data.cwd,
      runtime: context.data.runtime,
      timeoutMs,
    })
    if (!result.ok) return result
    return successExitCodes.includes(result.data.exitCode)
      ? result
      : commandFailed(operation, result.data)
  }

  const readStatus = async (workspaceId: string): Promise<IpcResult<GitStatus>> => {
    const result = await run(workspaceId, 'status', [
      'status',
      '--porcelain=v2',
      '--branch',
      '-z',
      // List untracked files individually: the default collapses untracked
      // directories to `? dir/`, which cannot be diffed (DiffService would
      // show an empty patch for everything the agent created inside it).
      '--untracked-files=all',
      '--',
      '.',
      ':(exclude)node_modules',
      ':(exclude)**/node_modules/**',
    ])
    return result.ok ? { ok: true, data: parseStatus(result.data.stdout) } : result
  }

  return {
    status(workspaceId) {
      const existing = statusInFlight.get(workspaceId)
      if (existing !== undefined) return existing
      const pending = readStatus(workspaceId).finally(() => {
        if (statusInFlight.get(workspaceId) === pending) statusInFlight.delete(workspaceId)
      })
      statusInFlight.set(workspaceId, pending)
      return pending
    },

    async branch(workspaceId) {
      const result = await run(workspaceId, 'branch', [
        'branch',
        '--format=%(HEAD)%00%(refname:short)',
      ])
      if (!result.ok) return result
      const branches = result.data.stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => ({ current: line.startsWith('*\0'), name: line.slice(2).trimEnd() }))
      // In a detached HEAD git lists a pseudo-ref as the current "branch"
      // (`(HEAD detached at …)` / `(no branch, rebasing …)`): it is not a real
      // branch, so it must not surface as `current` or in the branch list.
      const isPseudoRef = (entry: { current: boolean; name: string }): boolean =>
        entry.current && /^\((?:HEAD detached|no branch)\b/u.test(entry.name)
      const real = branches.filter((entry) => !isPseudoRef(entry))
      const current = real.find((branch) => branch.current)?.name
      return {
        ok: true,
        data: {
          current,
          detached: current === undefined,
          branches: real.map(({ name }) => name),
        },
      }
    },

    async diff(request) {
      if (request.path !== undefined && !validRelativePath(request.path)) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Git diff paths must stay inside the workspace.',
          retryable: false,
          detail: `rejected path=${JSON.stringify(request.path)}`,
        })
      }
      const args = ['diff', '--no-ext-diff', '--no-color']
      if (request.staged === true) args.push('--staged')
      if (request.path !== undefined) args.push('--', request.path)
      const result = await run(request.workspaceId, 'diff', args)
      return result.ok ? { ok: true, data: { patch: result.data.stdout } } : result
    },

    async diffRefs(request) {
      for (const ref of [request.baseRef, request.headRef]) {
        if (!VALID_REF.test(ref) || ref.includes('..')) {
          return fail({
            code: 'VALIDATION_FAILED',
            message: 'Git diff refs must be plain branch or revision names.',
            retryable: false,
            detail: `rejected ref=${JSON.stringify(ref)}`,
          })
        }
      }
      const result = await run(request.workspaceId, 'diff', [
        'diff',
        '--no-ext-diff',
        '--no-color',
        `${request.baseRef}...${request.headRef}`,
      ])
      return result.ok ? { ok: true, data: { patch: result.data.stdout } } : result
    },

    async diffNumstat(request) {
      if (request.path !== undefined && !validRelativePath(request.path)) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Git diff paths must stay inside the workspace.',
          retryable: false,
          detail: `rejected path=${JSON.stringify(request.path)}`,
        })
      }
      const args = ['diff', '--no-ext-diff', '--no-color', '--numstat', '-z']
      if (request.staged === true) args.push('--staged')
      args.push(
        '--',
        request.path ?? '.',
        ...(request.path === undefined
          ? [':(exclude)node_modules', ':(exclude)**/node_modules/**']
          : []),
      )
      const result = await run(request.workspaceId, 'diff-numstat', args)
      return result.ok ? { ok: true, data: parseNumstat(result.data.stdout) } : result
    },

    async log(request) {
      const result = await run(request.workspaceId, 'log', [
        'log',
        `-${String(request.limit ?? 50)}`,
        '--date=iso-strict',
        '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e',
      ])
      return result.ok ? { ok: true, data: parseLog(result.data.stdout) } : result
    },

    async commit(request) {
      if (request.all === true) {
        const staged = await run(request.workspaceId, 'add', ['add', '--all'], COMMIT_TIMEOUT_MS)
        if (!staged.ok) return staged
      }
      const committed = await run(
        request.workspaceId,
        'commit',
        ['commit', '--message', request.message],
        COMMIT_TIMEOUT_MS,
      )
      if (!committed.ok) return committed
      const revision = await run(request.workspaceId, 'rev-parse', ['rev-parse', 'HEAD'])
      if (!revision.ok) return revision
      deps.events.emit('git.changed', { workspaceId: request.workspaceId })
      return {
        ok: true,
        data: { hash: revision.data.stdout.trim(), output: committed.data.stdout.trim() },
      }
    },

    async openFile(request) {
      if (!validRelativePath(request.path)) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Git file paths must stay inside the workspace.',
          retryable: false,
          detail: `rejected path=${JSON.stringify(request.path)}`,
        })
      }
      if (deps.openPath === undefined) {
        return fail({
          code: 'CAPABILITY_NOT_AVAILABLE',
          message: 'Opening files is not available in this environment.',
          retryable: false,
          detail: 'GitManager was composed without an openPath adapter',
        })
      }
      const context = contextFor(request.workspaceId)
      if (!context.ok) return context
      const runtimePath = context.data.runtime.resolveCwd(
        `${context.data.cwd}/${request.path.replaceAll('\\', '/')}`,
      )
      const hostPath = context.data.runtime.resolveHostPath(runtimePath)
      if (!hostPath.ok) return hostPath
      try {
        const errorMessage = await deps.openPath(hostPath.data)
        return errorMessage.length === 0
          ? { ok: true, data: undefined }
          : fail({
              code: 'UNKNOWN',
              message: 'The file could not be opened.',
              retryable: true,
              detail: errorMessage,
            })
      } catch (cause) {
        return fail({
          code: 'UNKNOWN',
          message: 'The file could not be opened.',
          retryable: true,
          cause,
        })
      }
    },

    async untrackedDiff(workspaceId, path) {
      if (!validRelativePath(path)) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Git diff paths must stay inside the workspace.',
          retryable: false,
          detail: `rejected path=${JSON.stringify(path)}`,
        })
      }
      const result = await run(
        workspaceId,
        'diff',
        ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', '/dev/null', path],
        READ_TIMEOUT_MS,
        [0, 1],
      )
      return result.ok ? { ok: true, data: { patch: result.data.stdout } } : result
    },

    async untrackedNumstat(workspaceId, path) {
      if (!validRelativePath(path)) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Git diff paths must stay inside the workspace.',
          retryable: false,
          detail: `rejected path=${JSON.stringify(path)}`,
        })
      }
      const result = await run(
        workspaceId,
        'diff-numstat',
        [
          'diff',
          '--no-index',
          '--no-ext-diff',
          '--no-color',
          '--numstat',
          '-z',
          '--',
          '/dev/null',
          path,
        ],
        READ_TIMEOUT_MS,
        [0, 1],
      )
      if (!result.ok) return result
      const entry = parseNumstat(result.data.stdout).find((candidate) => candidate.path === path)
      return { ok: true, data: entry ?? { path, additions: 0, deletions: 0 } }
    },
  }
}
