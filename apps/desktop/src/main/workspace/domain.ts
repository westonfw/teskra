import { z } from 'zod'

import type { IpcResult, WorkspaceRuntimeRef } from '@teskra/contracts'
import { workspaceRuntimeRefSchema } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from '../errors'

/**
 * Workspace domain model (TASK-008, teskra-tasks.md).
 *
 * Owns the WorkspaceRuntimeRef (plan §116.1 — the nested
 * kind + distro/host/containerId shape, NOT the superseded §7.1 flat enum)
 * validation rules. The DB flattening into runtime_kind / wsl_distro /
 * ssh_host / container_id (plan §139.1) is the WorkspaceRepository's duty;
 * this module never touches SQL, node:fs, or electron.
 *
 * First version implements `windows` and `wsl`. `ssh` and `container` exist
 * in the type (contracts `runtimeKindSchema`) but are rejected here with a
 * structured CAPABILITY_NOT_AVAILABLE error — never a crash.
 */

export const IMPLEMENTED_RUNTIME_KINDS = ['windows', 'wsl'] as const

/** Drive-letter (`C:\` or `C:/`) or UNC (`\\server\share`) absolute path. */
const WINDOWS_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/

/** POSIX-absolute path; backslashes and NUL are never valid. */
function isWslPath(path: string): boolean {
  return path.startsWith('/') && !path.includes('\\') && !path.includes('\u0000')
}

function fail(error: InternalAppError): { ok: false; error: ReturnType<typeof toPublicError> } {
  return { ok: false, error: toPublicError(error) }
}

function validationFailed(message: string, detail: string) {
  return fail({ code: 'VALIDATION_FAILED', message, retryable: false, detail })
}

/**
 * Parses and validates a runtime ref: schema shape first, then per-kind
 * field rules. Unsupported kinds (ssh / container) fail before field rules,
 * because no combination of fields can make them usable yet.
 */
export function validateRuntimeRef(candidate: unknown): IpcResult<WorkspaceRuntimeRef> {
  const parsed = workspaceRuntimeRefSchema.safeParse(candidate)
  if (!parsed.success) {
    return validationFailed(
      'Invalid workspace runtime.',
      `runtime: ${JSON.stringify(parsed.error.issues)}`,
    )
  }
  const ref = parsed.data

  if (ref.kind === 'ssh' || ref.kind === 'container') {
    return fail({
      code: 'CAPABILITY_NOT_AVAILABLE',
      message: `Workspace runtime "${ref.kind}" is not supported yet.`,
      retryable: false,
      detail: `runtime kind "${ref.kind}" is declared in plan §116.1 but not implemented (TASK-008 first version: windows + wsl)`,
    })
  }

  if (ref.kind === 'windows') {
    if (ref.distro !== undefined || ref.host !== undefined || ref.containerId !== undefined) {
      return validationFailed(
        'A Windows workspace must not set distro, host, or containerId.',
        `windows runtime received ${JSON.stringify(ref)}`,
      )
    }
    return { ok: true, data: ref }
  }

  // kind === 'wsl'
  if (ref.distro === undefined || ref.distro.trim().length === 0) {
    return validationFailed(
      'A WSL workspace must name its distro.',
      'wsl runtime requires a non-empty distro (e.g. "Ubuntu-24.04")',
    )
  }
  if (ref.host !== undefined || ref.containerId !== undefined) {
    return validationFailed(
      'A WSL workspace must not set host or containerId.',
      `wsl runtime received ${JSON.stringify(ref)}`,
    )
  }
  return { ok: true, data: ref }
}

/**
 * Validates that `path` has the shape the runtime kind requires: Windows
 * paths for `windows`, POSIX-absolute Linux paths for `wsl`. This is a
 * shape check only — existence probing lives in WorkspaceManager (TASK-009)
 * and runtime-aware resolution in WorkspaceRuntime (TASK-010).
 */
export function validateWorkspacePath(
  runtime: WorkspaceRuntimeRef,
  path: string,
): IpcResult<string> {
  if (path.trim().length === 0 || path.includes('\u0000')) {
    return validationFailed('Workspace path must not be empty.', `path: ${JSON.stringify(path)}`)
  }
  if (runtime.kind === 'windows') {
    if (!WINDOWS_PATH_PATTERN.test(path)) {
      return validationFailed(
        'Invalid Windows workspace path.',
        `expected a drive-letter (C:\\…) or UNC (\\\\server\\share) path, got ${JSON.stringify(path)}`,
      )
    }
    return { ok: true, data: path }
  }
  if (runtime.kind === 'wsl') {
    if (!isWslPath(path)) {
      return validationFailed(
        'Invalid WSL workspace path.',
        `expected a POSIX-absolute path (/…), got ${JSON.stringify(path)}`,
      )
    }
    return { ok: true, data: path }
  }
  return fail({
    code: 'CAPABILITY_NOT_AVAILABLE',
    message: `Workspace runtime "${runtime.kind}" is not supported yet.`,
    retryable: false,
    detail: `cannot validate a path for unimplemented runtime kind "${runtime.kind}"`,
  })
}

/** A not-yet-persisted Workspace, as accepted by the Manager's create/open. */
export interface WorkspaceDraft {
  readonly name: string
  readonly runtime: WorkspaceRuntimeRef
  readonly path: string
  readonly gitRoot?: string | undefined
  readonly defaultBranch?: string | undefined
  /** Non-sensitive env vars only; secrets go through the Credential Store. */
  readonly env?: Record<string, string> | undefined
}

const workspaceDraftSchema = z.strictObject({
  name: z.string(),
  runtime: z.unknown(),
  path: z.string(),
  gitRoot: z.string().optional(),
  defaultBranch: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
})

/**
 * Full draft validation: schema shape, runtime ref rules, per-kind path
 * rules (path and gitRoot), and non-empty name / defaultBranch. The name is
 * normalized (trimmed); everything else passes through untouched.
 */
export function validateWorkspaceDraft(candidate: unknown): IpcResult<WorkspaceDraft> {
  const parsed = workspaceDraftSchema.safeParse(candidate)
  if (!parsed.success) {
    return validationFailed(
      'Invalid workspace definition.',
      `draft: ${JSON.stringify(parsed.error.issues)}`,
    )
  }

  const name = parsed.data.name.trim()
  if (name.length === 0) {
    return validationFailed('Workspace name must not be empty.', 'name is blank after trimming')
  }

  const runtime = validateRuntimeRef(parsed.data.runtime)
  if (!runtime.ok) {
    return runtime
  }

  const path = validateWorkspacePath(runtime.data, parsed.data.path)
  if (!path.ok) {
    return path
  }

  let gitRoot = parsed.data.gitRoot
  if (gitRoot !== undefined) {
    const validated = validateWorkspacePath(runtime.data, gitRoot)
    if (!validated.ok) {
      return validated
    }
    gitRoot = validated.data
  }

  if (parsed.data.defaultBranch !== undefined && parsed.data.defaultBranch.trim().length === 0) {
    return validationFailed(
      'Workspace default branch must not be empty.',
      'defaultBranch is blank after trimming',
    )
  }

  return {
    ok: true,
    data: {
      name,
      runtime: runtime.data,
      path: path.data,
      gitRoot,
      defaultBranch: parsed.data.defaultBranch,
      env: parsed.data.env,
    },
  }
}
