import { readFileSync } from 'node:fs'

import type { IpcResult } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from '../errors'
import type { CommandRunner } from './command-runner'

/**
 * Host-side process liveness probe / termination for crash recovery (P0-2).
 *
 * The ProcessManager registry is in-process only: after a restart it is empty
 * even when a previous instance's Agent processes are still alive on the host.
 * The recorded `agent_runs.pid` is the only handle left, so Reconciliation
 * probes it (POSIX `kill(pid, 0)`, Windows `tasklist`) and terminates
 * survivors before the run is allowed to be resumed — resuming onto a
 * worktree another live Agent is still writing to would double-write.
 *
 * `identity()` guards that kill against pid reuse: a pid alone does not name a
 * process — after a reboot or pid wraparound the same number belongs to an
 * unrelated process, and terminating it would be an arbitrary kill (on Windows
 * `taskkill /T /F` takes the whole tree with it). The token is the process
 * start time from the OS's own source (Linux `/proc/<pid>/stat` field 22,
 * other POSIX `ps -o lstart=`, Windows `Get-Process .StartTime`), captured at
 * launch and re-read at reconciliation time; a mismatch means the recorded
 * process is gone and the pid was recycled.
 *
 * Platform branching is confined to main/process/ (same exemption class as
 * CommandRunner; see the ESLint no-restricted-syntax block). One-shot host
 * commands (`tasklist` / `taskkill` / `ps` / PowerShell) go through the
 * injected CommandRunner — this module never spawns anything itself.
 */

export interface HostProcessControl {
  /** Structured result: a probe FAILURE is distinguishable from "not alive". */
  probe(pid: number): Promise<IpcResult<boolean>>
  /**
   * Process-start token for identity comparison; `null` when the pid is gone.
   * Tokens are only ever compared for equality against a value produced by the
   * same platform implementation — never parsed.
   */
  identity(pid: number): Promise<IpcResult<string | null>>
  /** Best-effort SIGTERM (POSIX) / `taskkill /T /F` (Windows) of a stray pid. */
  terminate(pid: number): Promise<IpcResult<void>>
}

export interface HostProcessControlDeps {
  readonly commands: CommandRunner
  /** Kill-semantics switch; defaults to process.platform (tests override). */
  readonly hostPlatform?: string | undefined
}

const PROBE_TIMEOUT_MS = 5_000
const TERMINATE_TIMEOUT_MS = 10_000

function fail(error: InternalAppError): IpcResult<never> {
  return { ok: false, error: toPublicError(error) }
}

function invalidPid(pid: number): boolean {
  return !Number.isInteger(pid) || pid <= 0
}

function probeFailed(pid: number, cause?: unknown): InternalAppError {
  return {
    code: 'UNKNOWN',
    message: `Failed to probe host process ${String(pid)}.`,
    retryable: true,
    detail: `liveness probe failed for pid ${String(pid)}`,
    ...(cause === undefined ? {} : { cause }),
  }
}

function identityFailed(pid: number, cause?: unknown): InternalAppError {
  return {
    code: 'UNKNOWN',
    message: `Failed to identify host process ${String(pid)}.`,
    retryable: true,
    detail: `start-time read failed for pid ${String(pid)}`,
    ...(cause === undefined ? {} : { cause }),
  }
}

function terminateFailed(pid: number, cause?: unknown): InternalAppError {
  return {
    code: 'UNKNOWN',
    message: `Failed to terminate host process ${String(pid)}.`,
    retryable: true,
    detail: `terminate failed for pid ${String(pid)}`,
    ...(cause === undefined ? {} : { cause }),
  }
}

function invalidPidResult<T>(operation: string, pid: number): IpcResult<T> {
  return fail({
    code: 'VALIDATION_FAILED',
    message: `Cannot ${operation} host process "${String(pid)}".`,
    retryable: false,
    detail: `${operation} requires a positive integer pid, got ${JSON.stringify(pid)}`,
  })
}

const IDENTITY_TIMEOUT_MS = 5_000

/**
 * Linux: field 22 (starttime, clock ticks since boot) of /proc/<pid>/stat.
 * The comm field (2) may contain spaces or ')' inside its parens, so parsing
 * resumes after the LAST ')'.
 */
function linuxIdentity(pid: number): IpcResult<string | null> {
  let stat: string
  try {
    stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'ENOENT'
      ? { ok: true, data: null }
      : fail(identityFailed(pid, cause))
  }
  const rest = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)
  // rest[0] is field 3 (state); field 22 sits at index 19.
  const token = rest[19]
  return token === undefined
    ? fail(identityFailed(pid, 'malformed stat'))
    : { ok: true, data: token }
}

function createPosixControl(commands: CommandRunner, hostPlatform: string): HostProcessControl {
  return {
    probe(pid) {
      if (invalidPid(pid)) return Promise.resolve(invalidPidResult('probe', pid))
      try {
        // Signal 0 performs error checking only: ESRCH = gone, EPERM = alive
        // but owned by another user (still counts as alive).
        process.kill(pid, 0)
        return Promise.resolve({ ok: true, data: true })
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        return Promise.resolve(
          code === 'ESRCH'
            ? { ok: true, data: false }
            : code === 'EPERM'
              ? { ok: true, data: true }
              : fail(probeFailed(pid, cause)),
        )
      }
    },
    async identity(pid) {
      if (invalidPid(pid)) return invalidPidResult('identify', pid)
      if (hostPlatform === 'linux') return linuxIdentity(pid)
      // Other POSIX (macOS): lstart is the process start time; the exact
      // rendering does not matter because tokens are only compared for
      // equality against the same command's output.
      const result = await commands.run({
        command: 'ps',
        args: ['-o', 'lstart=', '-p', String(pid)],
        timeoutMs: IDENTITY_TIMEOUT_MS,
      })
      if (!result.ok) return fail(identityFailed(pid, result.error))
      const token = result.data.stdout.trim()
      return { ok: true, data: result.data.exitCode === 0 && token !== '' ? token : null }
    },
    terminate(pid) {
      if (invalidPid(pid)) return Promise.resolve(invalidPidResult('terminate', pid))
      try {
        process.kill(pid, 'SIGTERM')
        return Promise.resolve({ ok: true, data: undefined })
      } catch (cause) {
        // Already gone between probe and terminate: the goal is met.
        return Promise.resolve(
          (cause as NodeJS.ErrnoException).code === 'ESRCH'
            ? { ok: true, data: undefined }
            : fail(terminateFailed(pid, cause)),
        )
      }
    },
  }
}

function createWindowsControl(commands: CommandRunner): HostProcessControl {
  return {
    async probe(pid) {
      if (invalidPid(pid)) return invalidPidResult('probe', pid)
      const result = await commands.run({
        command: 'tasklist',
        args: ['/FI', `PID eq ${String(pid)}`, '/NH'],
        timeoutMs: PROBE_TIMEOUT_MS,
      })
      if (!result.ok) return fail(probeFailed(pid, result.error))
      // tasklist exits 0 even when nothing matches ("INFO: No tasks …"), so
      // liveness is decided by the pid token appearing in the listing. Word
      // boundaries keep "12345" from matching "112345" or "12,345 K".
      const alive = new RegExp(`\\b${String(pid)}\\b`).test(result.data.stdout)
      return { ok: true, data: alive }
    },
    async identity(pid) {
      if (invalidPid(pid)) return invalidPidResult('identify', pid)
      // [Windows 验证] stubbed-CommandRunner unit coverage only.
      const result = await commands.run({
        command: 'powershell',
        args: [
          '-NoProfile',
          '-Command',
          `$p = Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`,
        ],
        timeoutMs: IDENTITY_TIMEOUT_MS,
      })
      if (!result.ok) return fail(identityFailed(pid, result.error))
      const token = result.data.stdout.trim()
      return { ok: true, data: result.data.exitCode === 0 && token !== '' ? token : null }
    },
    async terminate(pid) {
      if (invalidPid(pid)) return invalidPidResult('terminate', pid)
      const result = await commands.run({
        command: 'taskkill',
        args: ['/PID', String(pid), '/T', '/F'],
        timeoutMs: TERMINATE_TIMEOUT_MS,
      })
      if (!result.ok) return fail(terminateFailed(pid, result.error))
      return result.data.exitCode === 0
        ? { ok: true, data: undefined }
        : fail(terminateFailed(pid, result.data.stderr || result.data.stdout))
    },
  }
}

export function createHostProcessControl(deps: HostProcessControlDeps): HostProcessControl {
  const hostPlatform = deps.hostPlatform ?? process.platform
  // [Windows 验证] the tasklist/taskkill/PowerShell branches are exercised
  // with a stubbed CommandRunner in unit tests only; real Windows behavior is
  // unverified.
  return hostPlatform === 'win32'
    ? createWindowsControl(deps.commands)
    : createPosixControl(deps.commands, hostPlatform)
}
