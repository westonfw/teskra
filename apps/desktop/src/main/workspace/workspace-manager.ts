import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, win32 } from 'node:path'

import type { IpcResult, Workspace, WorkspaceRuntimeRef } from '@teskra/contracts'

import type { WorkspaceRepository } from '../db/repositories'
import { type InternalAppError, toPublicError } from '../errors'
import { validateWorkspaceDraft, type WorkspaceDraft } from './domain'
import { createWorkspaceRuntime, type WorkspaceRuntime } from './runtime'

/**
 * WorkspaceManager (TASK-009, teskra-tasks.md) — create / open / remove /
 * listRecent / validate on top of the domain rules (TASK-008) and the
 * WorkspaceRepository (TASK-007). No SQL and no electron imports here.
 *
 * Existence probing goes through the WorkspaceRuntime abstraction (TASK-010):
 * `runtime.hostNative` tells whether node:fs on this host can stat the
 * workspace path directly (Windows paths on Windows, WSL paths on the
 * Linux/WSL2 dev host). Non-native paths report "not checkable" — real
 * probing through wsl.exe belongs to the runtime's command path, not here.
 */

export interface OpenWorkspaceInput {
  /** Defaults to the path's basename (win32-aware for `windows` runtimes). */
  readonly name?: string
  readonly runtime: WorkspaceRuntimeRef
  readonly path: string
  readonly gitRoot?: string
  readonly defaultBranch?: string
  readonly env?: Record<string, string>
}

export interface WorkspaceValidation {
  /** true/false when the host could probe the path; null when it could not. */
  readonly exists: boolean | null
}

export interface WorkspaceManager {
  /** Registers a new workspace; a duplicate (runtime, path) is rejected. */
  create(input: WorkspaceDraft): IpcResult<Workspace>
  /**
   * Idempotent open: an existing workspace with the same (runtime, path)
   * identity is reused (lastOpenedAt bumped), otherwise a new one is created.
   * A host-checkable path that does not exist fails with WORKSPACE_NOT_FOUND.
   */
  open(input: OpenWorkspaceInput): IpcResult<Workspace>
  /** true when a workspace was deleted, false when the id was unknown. */
  remove(id: string): IpcResult<boolean>
  /** Most recently opened first; never-opened workspaces last. */
  listRecent(limit?: number): IpcResult<Workspace[]>
  /** Domain validation + existence probe; never writes anything. */
  validate(input: OpenWorkspaceInput): IpcResult<WorkspaceValidation>
}

export interface WorkspaceManagerOptions {
  /** Injectable clock for tests; defaults to the current time (ISO UTC). */
  readonly now?: () => string
  /**
   * Runtime resolution (TASK-010); defaults to the real factory probing the
   * host platform. Tests may inject a stub to control host-nativeness.
   */
  readonly createRuntime?: (ref: WorkspaceRuntimeRef) => IpcResult<WorkspaceRuntime>
}

function fail(error: InternalAppError): { ok: false; error: ReturnType<typeof toPublicError> } {
  return { ok: false, error: toPublicError(error) }
}

function defaultName(runtime: WorkspaceRuntimeRef, path: string): string {
  const base = runtime.kind === 'windows' ? win32.basename(path) : basename(path)
  return base.length > 0 ? base : path
}

/** Probes directory existence; null means the host cannot check this path. */
function probeDirectory(path: string, checkable: boolean): IpcResult<boolean | null> {
  if (!checkable) {
    return { ok: true, data: null }
  }
  try {
    return { ok: true, data: statSync(path).isDirectory() }
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { ok: true, data: false }
    }
    return fail({
      code: 'UNKNOWN',
      message: 'Failed to check the workspace directory.',
      retryable: true,
      detail: `stat failed for ${path}`,
      cause,
    })
  }
}

export function createWorkspaceManager(
  repository: WorkspaceRepository,
  options: WorkspaceManagerOptions = {},
): WorkspaceManager {
  const now = options.now ?? (() => new Date().toISOString())
  const createRuntime =
    options.createRuntime ?? ((ref: WorkspaceRuntimeRef) => createWorkspaceRuntime(ref))

  /** Probes via the runtime's host-nativeness; null means "not checkable". */
  const probe = (ref: WorkspaceRuntimeRef, path: string): IpcResult<boolean | null> => {
    const runtime = createRuntime(ref)
    if (!runtime.ok) {
      return runtime
    }
    return probeDirectory(path, runtime.data.hostNative)
  }

  const manager: WorkspaceManager = {
    create(input) {
      const draft = validateWorkspaceDraft(input)
      if (!draft.ok) {
        return draft
      }
      const existing = repository.findByPath(draft.data.runtime, draft.data.path)
      if (!existing.ok) {
        return existing
      }
      if (existing.data !== null) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'A workspace for this runtime and path already exists.',
          retryable: false,
          detail: `duplicate of workspace ${existing.data.id}; use open() for idempotent opens`,
        })
      }
      return repository.create({ id: randomUUID(), ...draft.data }, now())
    },

    open(input) {
      const draft = validateWorkspaceDraft({
        ...input,
        name: input.name ?? defaultName(input.runtime, input.path),
      })
      if (!draft.ok) {
        return draft
      }

      const exists = probe(draft.data.runtime, draft.data.path)
      if (!exists.ok) {
        return exists
      }
      if (exists.data === false) {
        return fail({
          code: 'WORKSPACE_NOT_FOUND',
          message: 'The workspace directory does not exist.',
          retryable: false,
          detail: `no directory at ${draft.data.path}`,
        })
      }

      const existing = repository.findByPath(draft.data.runtime, draft.data.path)
      if (!existing.ok) {
        return existing
      }
      if (existing.data !== null) {
        const reopened = repository.update(existing.data.id, { lastOpenedAt: now() }, now())
        if (!reopened.ok) {
          return reopened
        }
        if (reopened.data === null) {
          return fail({
            code: 'UNKNOWN',
            message: 'Failed to reopen the workspace.',
            retryable: true,
            detail: `workspace ${existing.data.id} vanished between findByPath and update`,
          })
        }
        return { ok: true, data: reopened.data }
      }

      const timestamp = now()
      return repository.create(
        { id: randomUUID(), ...draft.data, lastOpenedAt: timestamp },
        timestamp,
      )
    },

    remove(id) {
      return repository.delete(id)
    },

    listRecent(limit = 10) {
      return repository.listRecent(limit)
    },

    validate(input) {
      const draft = validateWorkspaceDraft({
        ...input,
        name: input.name ?? defaultName(input.runtime, input.path),
      })
      if (!draft.ok) {
        return draft
      }
      const exists = probe(draft.data.runtime, draft.data.path)
      if (!exists.ok) {
        return exists
      }
      return { ok: true, data: { exists: exists.data } }
    },
  }

  return manager
}
