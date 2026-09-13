import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

import type { IpcResult } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { WorkspaceRuntime } from '../workspace/runtime'
import {
  buildCmdShimSpawn,
  cmdShimArgsNeedDirectLaunch,
  type CmdShimIO,
  isWindowsCmdShim,
  resolveCmdShimDirectLaunch,
  resolveWindowsCommandPath,
} from './windows-shim'

/**
 * CommandRunner (TASK-012, teskra-tasks.md; plan §150).
 *
 * The single authority for one-shot commands (`git status`, `where codex`,
 * `wsl --status`, …). Interactive processes belong to ProcessManager
 * (TASK-013+); anything long-lived must NOT go through this module.
 *
 * Hard guarantees:
 *
 * - `timeoutMs` is REQUIRED — there is no default that lets a command hang
 *   forever (plan §150). The field is non-optional, so omitting it is a
 *   compile-time error.
 * - A timeout / abort / maxBuffer overflow really KILLS the child process
 *   tree (never a bare `Promise.race`, which leaves orphans). POSIX spawns
 *   the child in its own process group (`detached`) and signals the whole
 *   group; Windows uses `taskkill /PID <pid> /T /F`.
 * - Platform branching is confined to this module (process infrastructure,
 *   same exemption class as workspace/runtime.ts — see the ESLint
 *   no-restricted-syntax block in eslint.config.mjs).
 *
 * This module is the ONLY main-process module allowed to import
 * node:child_process for one-shot commands (enforced by an ESLint
 * no-restricted-imports rule); every consumer injects a CommandRunner.
 *
 * Output is buffered (that is what "one-shot" means here) and decoded as
 * utf8 by default or utf16le on request — `wsl.exe --list --quiet` emits
 * UTF-16LE and decodes to garbage as UTF-8 (TASK-011).
 */

export type CommandOutputEncoding = 'utf8' | 'utf16le'

export interface CommandRequest {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string | undefined
  /**
   * REQUIRED (plan §150): hard ceiling for the whole command. On expiry the
   * process tree is killed and the result is a COMMAND_TIMEOUT error.
   */
  readonly timeoutMs: number
  /** Cancellation: kills the process tree exactly like a timeout. */
  readonly signal?: AbortSignal
  /** stdout/stderr decoding; defaults to utf8. wsl.exe needs utf16le. */
  readonly encoding?: CommandOutputEncoding
  /** Per-stream byte ceiling; exceeding it kills the command. Default 10 MiB. */
  readonly maxBuffer?: number
  /**
   * Workspace runtime context (TASK-010): the command is wrapped via
   * `runtime.resolveCommand` (e.g. `wsl.exe -d <distro> …`).
   */
  readonly runtime?: WorkspaceRuntime
  /** Observability hook (audit/tests): fired once the child has a PID. */
  readonly onSpawn?: (pid: number) => void
}

export interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  /**
   * Process exit code. Non-zero is NOT an error by itself (`git diff` exits
   * 1 with differences) — callers decide. -1 when the process died by signal.
   */
  readonly exitCode: number
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<IpcResult<CommandResult>>
}

export interface CommandRunnerDeps {
  /** Kill-semantics switch; defaults to process.platform (tests override). */
  readonly hostPlatform?: string | undefined
  /** Tree-kill seam for tests; defaults to the platform killProcessTree. */
  readonly killTree?: (child: ChildProcess, hostPlatform: string) => void
  /** Spawn seam for tests (e.g. asserting the .cmd shim launch shape). */
  readonly spawn?: typeof spawn
  /** Shim-file seam for cmd-shim unwrapping tests; production binds node:fs. */
  readonly shimIO?: CmdShimIO
}

/** node:fs binding for the CmdShimIO seam (read failures degrade to fallback). */
function createNodeShimIO(): CmdShimIO {
  return {
    read(path) {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    },
    exists: (path) => existsSync(path),
  }
}

export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024

/** Decodes buffered output; exported so detection code and tests share it. */
export function decodeCommandOutput(
  chunks: readonly Buffer[],
  encoding: CommandOutputEncoding,
): string {
  return Buffer.concat(chunks).toString(encoding)
}

/**
 * Really terminates the child and its descendants. POSIX: the child was
 * spawned `detached`, so it leads its own process group and a negative PID
 * signals the whole group; the plain-child fallback covers the race where
 * the group is already gone. Windows: `taskkill /T` walks the tree.
 */
function killProcessTree(child: ChildProcess, hostPlatform: string): void {
  const pid = child.pid
  if (pid === undefined) {
    return
  }
  if (hostPlatform === 'win32') {
    // [Windows 验证] taskkill tree-kill semantics are exercised only on
    // Windows; the POSIX branch is what unit tests cover on dev machines.
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.on('error', () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

interface ActiveChild {
  child: ChildProcess
  /** P2-6: the tree-kill itself must be idempotent — settle() already is. */
  killed: boolean
  settle(outcome: IpcResult<CommandResult>): void
}

export function createCommandRunner(deps: CommandRunnerDeps = {}): CommandRunner {
  const hostPlatform = deps.hostPlatform ?? process.platform
  const killTree = deps.killTree ?? killProcessTree
  const spawnProcess = deps.spawn ?? spawn
  const shimIO = deps.shimIO ?? createNodeShimIO()
  const logger = getLogger('process')
  /** Bare-name → resolved path cache; PATH/PATHEXT are stable within a run. */
  const commandPathCache = new Map<string, string | undefined>()

  /**
   * Bare command names (e.g. shell workflow steps like `npm test`) must be
   * resolved to a real file first: on Windows the name usually exists only
   * as a `.cmd` shim, which Node cannot spawn directly. Everything else
   * (qualified paths, POSIX hosts) passes through untouched.
   */
  const resolveExecutable = (executable: string): string => {
    if (hostPlatform !== 'win32') {
      return executable
    }
    const cached = commandPathCache.get(executable)
    if (cached !== undefined || commandPathCache.has(executable)) {
      return cached ?? executable
    }
    const resolved = resolveWindowsCommandPath(
      executable,
      shimIO,
      process.env['PATH'],
      process.env['PATHEXT'],
    )
    commandPathCache.set(executable, resolved)
    return resolved ?? executable
  }

  /** Kill the tree exactly once and settle with the given error. */
  const terminate = (active: ActiveChild, error: InternalAppError): void => {
    if (!active.killed) {
      active.killed = true
      killTree(active.child, hostPlatform)
    }
    active.settle({ ok: false, error: toPublicError(error) })
  }

  return {
    run(request) {
      if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0) {
        return Promise.resolve({
          ok: false,
          error: toPublicError({
            code: 'VALIDATION_FAILED',
            message: 'Command timeoutMs must be a positive integer.',
            retryable: false,
            detail: `command=${request.command} timeoutMs=${String(request.timeoutMs)}`,
          }),
        })
      }

      const args = request.args ?? []
      const rawContext =
        request.runtime !== undefined
          ? request.runtime.resolveCommand(request.command, args, request.cwd)
          : {
              executable: request.command,
              args,
              ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
            }
      const context = { ...rawContext, executable: resolveExecutable(rawContext.executable) }
      const encoding = request.encoding ?? 'utf8'
      const maxBuffer = request.maxBuffer ?? DEFAULT_MAX_BUFFER

      return new Promise<IpcResult<CommandResult>>((resolve) => {
        let settled = false
        const active: ActiveChild = {
          child: undefined as unknown as ChildProcess,
          killed: false,
          settle(outcome) {
            if (settled) {
              return
            }
            settled = true
            clearTimeout(timer)
            request.signal?.removeEventListener('abort', onAbort)
            resolve(outcome)
          },
        }

        const onAbort = (): void => {
          terminate(active, {
            code: 'UNKNOWN',
            message: `Command "${request.command}" was aborted.`,
            retryable: true,
            detail: `aborted via AbortSignal: ${context.executable} ${context.args.join(' ')}`,
          })
        }

        if (request.signal?.aborted === true) {
          resolve(
            toPublicErrorResult({
              code: 'UNKNOWN',
              message: `Command "${request.command}" was aborted.`,
              retryable: true,
              detail: 'AbortSignal was already aborted before spawn',
            }),
          )
          return
        }

        let child: ChildProcess
        try {
          // npm-installed CLIs resolve (via where.exe) to `.cmd`/`.bat` shims
          // that Node refuses to spawn directly (EINVAL, CVE-2024-27980);
          // launch those through cmd.exe with verbatim arguments instead.
          // Arguments cmd cannot transport (line breaks, ~8191-char ceiling)
          // unwrap the shim and spawn its real target directly; unparseable
          // shims fall back to the cmd.exe shape, no worse than before.
          const isShim = hostPlatform === 'win32' && isWindowsCmdShim(context.executable)
          const needsDirect =
            isShim && cmdShimArgsNeedDirectLaunch(context.executable, context.args)
          const directLaunch = needsDirect
            ? resolveCmdShimDirectLaunch(context.executable, shimIO, process.env['PATH'])
            : undefined
          if (needsDirect && directLaunch === undefined) {
            logger.warn(
              { command: request.command, executable: context.executable },
              'Shim could not be unwrapped; multi-line/long arguments may reach the process truncated.',
            )
          }
          const shim =
            isShim && directLaunch === undefined
              ? buildCmdShimSpawn(context.executable, context.args, process.env['ComSpec'])
              : undefined
          child = spawnProcess(
            directLaunch?.command ?? shim?.command ?? context.executable,
            directLaunch !== undefined
              ? [...directLaunch.argsPrefix, ...context.args]
              : [...(shim?.args ?? context.args)],
            {
              cwd: context.cwd,
              // POSIX: own process group so tree-kill can signal -pid.
              // Windows: process groups do not exist; taskkill /T instead.
              detached: hostPlatform !== 'win32',
              windowsHide: true,
              ...(shim !== undefined ? { windowsVerbatimArguments: shim.verbatim } : {}),
            },
          )
        } catch (cause) {
          resolve(
            toPublicErrorResult({
              code: 'UNKNOWN',
              message: `Failed to start command "${request.command}".`,
              retryable: false,
              detail: `spawn threw for ${context.executable}`,
              cause,
            }),
          )
          return
        }
        active.child = child
        if (child.pid !== undefined) {
          request.onSpawn?.(child.pid)
        }
        request.signal?.addEventListener('abort', onAbort, { once: true })

        const timer = setTimeout(() => {
          terminate(active, {
            code: 'COMMAND_TIMEOUT',
            message: `Command "${request.command}" timed out after ${request.timeoutMs}ms.`,
            retryable: true,
            detail: `killed process tree of ${context.executable} ${context.args.join(' ')} (pid ${String(child.pid)})`,
          })
        }, request.timeoutMs)

        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        let stdoutBuffered = 0
        let stderrBuffered = 0
        // The ceiling is PER STREAM (see CommandRequest.maxBuffer): stdout and
        // stderr are buffered independently, so a loud-but-legal stderr must
        // not eat stdout's budget.
        const onChunk = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
          if (stream === 'stdout') {
            stdoutBuffered += chunk.length
          } else {
            stderrBuffered += chunk.length
          }
          if (stdoutBuffered > maxBuffer || stderrBuffered > maxBuffer) {
            terminate(active, {
              code: 'UNKNOWN',
              message: `Command "${request.command}" exceeded the output limit.`,
              retryable: false,
              detail: `maxBuffer=${String(maxBuffer)} exceeded by ${context.executable}`,
            })
          }
        }
        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutChunks.push(chunk)
          onChunk('stdout', chunk)
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          stderrChunks.push(chunk)
          onChunk('stderr', chunk)
        })

        child.on('error', (cause) => {
          active.settle({
            ok: false,
            error: toPublicError({
              code: 'UNKNOWN',
              message: `Failed to start command "${request.command}".`,
              retryable: false,
              detail: `spawn failed for ${context.executable}: ${(cause as NodeJS.ErrnoException).code ?? 'unknown'}`,
              cause,
            }),
          })
        })

        child.on('close', (code, signal) => {
          logger.debug(
            { command: request.command, pid: child.pid, exitCode: code, signal },
            'command exited',
          )
          active.settle({
            ok: true,
            data: {
              stdout: decodeCommandOutput(stdoutChunks, encoding),
              stderr: decodeCommandOutput(stderrChunks, encoding),
              exitCode: code ?? -1,
            },
          })
        })
      })
    },
  }
}

function toPublicErrorResult(error: InternalAppError): IpcResult<CommandResult> {
  return { ok: false, error: toPublicError(error) }
}
