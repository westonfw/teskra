import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

import type { IpcResult, WorkspaceRuntimeRef } from '@teskra/contracts'

import type { CommandRunner } from '../../../process/command-runner'
import { createWorkspaceRuntime, type WorkspaceRuntime } from '../../../workspace/runtime'

/**
 * Milestone 24 §10.3 — the single implementation of "probe existence, NEVER
 * read contents" for account profile auth files (Codex `auth.json`, Claude
 * `.credentials.json`). Both account adapters funnel their detectStatus
 * probe through this module so the argv-only / no-content-read rule has
 * exactly one home.
 *
 * Two probe mechanisms, chosen by the runtime:
 * - host-native runtime: node:fs IS the runtime's filesystem, so a plain
 *   existence check answers directly.
 * - WSL-on-Windows: the file lives inside the distro filesystem, which
 *   node:fs cannot stat — probe with an argv-array `test -f/-e` through the
 *   CommandRunner (the same mechanism the AccountProfileManager uses for
 *   profile-home fs operations), never a shell string.
 */

/**
 * Coarse probe outcome; each adapter maps it onto its own status vocabulary.
 * - `exists` / `missing`: the probe answered conclusively.
 * - `unexpected`: the WSL `test` ran but exited with a code other than 0/1.
 * - `unknown`: the probe could not run at all (no runner, command failure,
 *   host fs error) — adapters must never guess `ready` from this.
 */
export type RuntimeFileProbeOutcome = 'exists' | 'missing' | 'unexpected' | 'unknown'

export interface RuntimeFileProbeRequest {
  readonly runtime: WorkspaceRuntime
  /** Runtime-native absolute directory containing the file (the config home). */
  readonly directory: string
  /** Single file-name segment inside `directory`. */
  readonly fileName: string
  /**
   * WSL probe flag: `-f` (regular file) or `-e` (any existence). Kept per
   * caller because the two agents' auth artifacts differ in kind.
   */
  readonly testFlag: '-f' | '-e'
  readonly timeoutMs: number
  /** Required for WSL-on-Windows; without it the probe reports `unknown`. */
  readonly commands?: CommandRunner | undefined
  /** Host-native existence seam (tests inject; production = node:fs). */
  readonly hostFileExists?: ((path: string) => boolean) | undefined
}

/** Joins in the runtime's own path flavor — never the dev host's. */
export function joinRuntimePath(
  runtime: WorkspaceRuntime,
  directory: string,
  fileName: string,
): string {
  return runtime.ref.kind === 'windows'
    ? win32.join(directory, fileName)
    : posix.join(directory, fileName)
}

export async function probeRuntimeFileExists(
  request: RuntimeFileProbeRequest,
): Promise<RuntimeFileProbeOutcome> {
  const path = joinRuntimePath(request.runtime, request.directory, request.fileName)

  if (request.runtime.hostNative) {
    const hostFileExists = request.hostFileExists ?? existsSync
    try {
      return hostFileExists(path) ? 'exists' : 'missing'
    } catch {
      return 'unknown'
    }
  }

  if (request.commands === undefined) {
    return 'unknown'
  }
  const probe = await request.commands.run({
    command: 'test',
    args: [request.testFlag, path],
    runtime: request.runtime,
    timeoutMs: request.timeoutMs,
  })
  if (!probe.ok) {
    return 'unknown'
  }
  if (probe.data.exitCode === 0) {
    return 'exists'
  }
  return probe.data.exitCode === 1 ? 'missing' : 'unexpected'
}

/** The shared default for the adapters' createRuntime test seam. */
export function defaultRuntimeFactory(ref: WorkspaceRuntimeRef): IpcResult<WorkspaceRuntime> {
  return createWorkspaceRuntime(ref)
}
