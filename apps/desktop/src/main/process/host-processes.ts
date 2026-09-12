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
 * Platform branching is confined to main/process/ (same exemption class as
 * CommandRunner; see the ESLint no-restricted-syntax block). One-shot host
 * commands (`tasklist` / `taskkill`) go through the injected CommandRunner —
 * this module never spawns anything itself.
 */

export interface HostProcessControl {
  /** Structured result: a probe FAILURE is distinguishable from "not alive". */
  probe(pid: number): Promise<IpcResult<boolean>>
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

function createPosixControl(): HostProcessControl {
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
  // [Windows 验证] the tasklist/taskkill branch is exercised with a stubbed
  // CommandRunner in unit tests only; real Windows behavior is unverified.
  return hostPlatform === 'win32' ? createWindowsControl(deps.commands) : createPosixControl()
}
