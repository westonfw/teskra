import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, posix, win32 } from 'node:path'

import type {
  AccountAuthType,
  AccountProfileStatus,
  AgentAccountProfile,
  AgentRunStatus,
  IpcResult,
  WorkbenchEvents,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'
import { agentAccountProfileSchema } from '@teskra/contracts'

import type { ConfigService } from '../../config/config-service'
import type {
  AccountProfileListFilter,
  AccountProfileRepository,
  AccountEventRepository,
  AgentRunRepository,
} from '../../db/repositories'
import { type InternalAppError, toPublicError } from '../../errors'
import type { EventBus } from '../../events/event-bus'
import { getLogger } from '../../logger'
import type { TeskraPaths } from '../../paths'
import type { CommandRunner } from '../../process/command-runner'
import { createWorkspaceRuntime, type WorkspaceRuntime } from '../../workspace/runtime'
import type { AgentRegistry } from '../agent-registry'
import type { AccountProfileAdapterRegistry } from './account-profile-adapter'
import type { AccountProfileStatusService } from './account-profile-status-service'
import {
  createAccountProfileRuntimeResolver,
  type AccountProfileRuntimeResolver,
} from './account-profile-runtime-resolver'
import { normalizeWindowsConfigHome, WINDOWS_DRIVE_ABSOLUTE } from './external-config-home'

/**
 * AccountProfileManager (TASK-097, Milestone 24 / ADR-0009).
 *
 * Owns the account profile lifecycle: creation with Teskra-generated
 * configHome (§48.1), soft-disable removal (§47.1), the default-profile
 * setting (§15, stored in the global config layer), status transitions, and
 * the §48.2 Path Ownership Guard. No SQL (the Repository does that), no
 * Electron, no Renderer knowledge.
 *
 * Create order (§9.2 / §48.1, load-bearing):
 *
 *   resolveAgentProfileHome()   pure computation
 *     → INSERT                  the per-runtime config_home unique index
 *                               blocks concurrent same-slug creation
 *     → createAgentProfileHome() only after the row exists
 *     → mkdir failure compensates by deleting the just-inserted row
 *
 * Profile-home fs operations are runtime-aware (§48.2 (b)): host-native
 * runtimes use node:fs; WSL-on-Windows executes realpath / mkdir / rm INSIDE
 * the distro through CommandRunner with argv arrays (never a shell string).
 */

/** §48.1: the only user-controlled segment of a managed configHome. */
export const ACCOUNT_PROFILE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

const TERMINAL_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

const PROFILE_FS_TIMEOUT_MS = 10_000

export interface CreateAccountProfileRequest {
  readonly agentId: string
  readonly name: string
  readonly description?: string | undefined
  readonly authType: AccountAuthType
  readonly runtime: WorkspaceRuntimeRef
  /**
   * Managed profiles (subscription) only: the single user-controlled path
   * segment. Lowercased before it is stored; conflicts are reported, never
   * auto-suffixed (§48.1).
   */
  readonly slug?: string | undefined
  /**
   * External profiles (§49) only: an existing CLI home, as an expanded
   * absolute path in the profile's runtime. Managed profiles never accept
   * this field — their configHome is generated (§48.1).
   */
  readonly configHome?: string | undefined
  /** §46: undefined = profile default (managed: 1); >= 1 integer otherwise. */
  readonly maxConcurrentRuns?: number | undefined
}

export interface UpdateAccountProfileRequest {
  readonly name?: string | undefined
  readonly description?: string | null | undefined
  readonly maxConcurrentRuns?: number | null | undefined
  readonly status?: AccountProfileStatus | undefined
  readonly limitedUntil?: string | null | undefined
}

export interface RemoveAccountProfileOptions {
  /** §47.1: delete the local CLI profile data too. Managed profiles only. */
  readonly deleteHome?: boolean | undefined
}

export interface AccountProfileManager {
  list(filter?: AccountProfileListFilter): Promise<IpcResult<AgentAccountProfile[]>>
  get(id: string): Promise<IpcResult<AgentAccountProfile | null>>
  create(request: CreateAccountProfileRequest): Promise<IpcResult<AgentAccountProfile>>
  update(id: string, patch: UpdateAccountProfileRequest): Promise<IpcResult<AgentAccountProfile>>
  /** Soft disable (§47.1) — never a DELETE. */
  remove(id: string, options?: RemoveAccountProfileOptions): Promise<IpcResult<AgentAccountProfile>>
  enable(id: string): Promise<IpcResult<AgentAccountProfile>>
  /** §15: per-agent default; null clears it. */
  setDefault(agentId: string, profileId: string | null): Promise<IpcResult<void>>
  getDefault(agentId: string): Promise<IpcResult<string | undefined>>
  /** §37 selector: explicit id → default → undefined (legacy fallback). */
  resolve(
    agentId: string,
    workspaceRuntime: WorkspaceRuntimeRef,
    explicitProfileId?: string,
  ): Promise<IpcResult<AgentAccountProfile | undefined>>
  /** Pluggable per-agent adapters (§10.4); undefined when none registered. */
  adapterFor(agentId: string): ReturnType<AccountProfileAdapterRegistry['get']>
  /** §13.2: the union of every registered adapter's reserved env keys. */
  reservedEnvKeys(): readonly string[]
}

export interface AccountProfileManagerDeps {
  readonly profiles: AccountProfileRepository
  readonly runs: Pick<AgentRunRepository, 'listByAccountProfile'>
  readonly registry: Pick<AgentRegistry, 'has'>
  readonly paths: TeskraPaths
  readonly config: Pick<ConfigService, 'resolve' | 'updateGlobal'>
  readonly events: EventBus<WorkbenchEvents>
  readonly adapters?: AccountProfileAdapterRegistry
  /**
   * TASK-106 (§18.0 lazy path): when composed, list() first sweeps expired
   * `limited` rows (so status filtering stays truthful) and get()
   * write-through degrades the single row it read. Without it, reads return
   * rows exactly as stored (TASK-097 behavior).
   */
  readonly status?: Pick<
    AccountProfileStatusService,
    'sweepExpiredLimited' | 'degradeExpiredLimited'
  >
  /**
   * TASK-116 (§41): audit sink for the account lifecycle events
   * (account.created / account.updated / account.status_changed). Append
   * failures are logged, never fatal — the lifecycle operation stands.
   */
  readonly accountEvents?: Pick<AccountEventRepository, 'append'>
  readonly createRuntime?: (ref: WorkspaceRuntimeRef) => IpcResult<WorkspaceRuntime>
  /** Required for WSL-on-Windows profile fs operations (§48.2 (b)). */
  readonly commands?: CommandRunner
  readonly createId?: () => string
  readonly now?: () => string
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function runtimeKey(ref: WorkspaceRuntimeRef): string {
  return ref.kind === 'wsl' ? `wsl:${(ref.distro ?? '').toLowerCase()}` : ref.kind
}

/** Containment on canonical paths; Windows filesystems fold case. */
function isWithinRoot(root: string, candidate: string, caseInsensitive: boolean): boolean {
  const r = caseInsensitive ? root.toLowerCase() : root
  const c = caseInsensitive ? candidate.toLowerCase() : candidate
  return c === r || c.startsWith(`${r}/`) || c.startsWith(`${r}\\`)
}

/**
 * §9.1 depth: a managed home is exactly `<root>/<agentId>/<slug>` — the root
 * itself and shallower/deeper paths are never valid fs-mutation targets.
 * Both segments are single non-empty names (slug rules forbid separators).
 */
function hasManagedHomeDepth(root: string, canonical: string, caseInsensitive: boolean): boolean {
  const r = caseInsensitive ? root.toLowerCase() : root
  const c = caseInsensitive ? canonical.toLowerCase() : canonical
  const separator = c.startsWith(`${r}/`) ? '/' : c.startsWith(`${r}\\`) ? '\\' : undefined
  if (separator === undefined) {
    return false
  }
  const segments = c.slice(r.length + 1).split(/[/\\]/u)
  return (
    segments.length === 2 &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  )
}

export function createAccountProfileManager(
  deps: AccountProfileManagerDeps,
): AccountProfileManager {
  const createId = deps.createId ?? ((): string => randomUUID())
  const now = deps.now ?? ((): string => new Date().toISOString())
  const createRuntime =
    deps.createRuntime ??
    ((ref: WorkspaceRuntimeRef): IpcResult<WorkspaceRuntime> =>
      createWorkspaceRuntime(ref, { paths: deps.paths }))

  /** §48.2 (a0): trusted agent-profiles roots, resolved once per process. */
  const trustedRoots = new Map<string, string>()

  const resolver: AccountProfileRuntimeResolver = createAccountProfileRuntimeResolver({
    profiles: deps.profiles,
    defaults: { getDefault: (agentId) => manager.getDefault(agentId) },
  })

  /** TASK-116 (§41): best-effort audit append — failures are logged, never fatal. */
  const audit = (eventType: string, profileId: string, payload: Record<string, unknown>): void => {
    if (deps.accountEvents === undefined) {
      return
    }
    const appended = deps.accountEvents.append({ profileId, eventType, payload }, now())
    if (!appended.ok) {
      getLogger('account').error(
        { profileId, eventType, error: appended.error },
        'Failed to persist the account audit event.',
      )
    }
  }

  const emitStatusChanged = (profile: AgentAccountProfile, status: AccountProfileStatus): void => {
    if (status !== profile.status) {
      deps.events.emit('account.status_changed', {
        profileId: profile.id,
        agentId: profile.agentId,
        status,
        previousStatus: profile.status,
      })
      audit('account.status_changed', profile.id, {
        agentId: profile.agentId,
        status,
        previousStatus: profile.status,
      })
    }
  }

  // ------------------------------------------------------------------
  // §48.2 Path Ownership Guard
  // ------------------------------------------------------------------

  const runFs = (
    runtime: WorkspaceRuntime,
    command: string,
    args: readonly string[],
  ): ReturnType<CommandRunner['run']> => {
    if (deps.commands === undefined) {
      return Promise.resolve(
        fail({
          code: 'CAPABILITY_NOT_AVAILABLE',
          message: 'WSL profile directories cannot be managed without a command runner.',
          retryable: false,
          detail: 'AccountProfileManager has no CommandRunner for WSL-on-Windows fs operations',
        }),
      )
    }
    return deps.commands.run({ command, args, runtime, timeoutMs: PROFILE_FS_TIMEOUT_MS })
  }

  const runFsChecked = async (
    runtime: WorkspaceRuntime,
    operation: string,
    command: string,
    args: readonly string[],
    successExitCodes: readonly number[] = [0],
  ): Promise<IpcResult<string>> => {
    const result = await runFs(runtime, command, args)
    if (!result.ok) {
      return result
    }
    if (!successExitCodes.includes(result.data.exitCode)) {
      return fail({
        code: 'UNKNOWN',
        message: `Failed to ${operation} the profile directory.`,
        retryable: true,
        detail: `${operation}: ${command} exited ${String(result.data.exitCode)}: ${result.data.stderr.trim()}`,
      })
    }
    return { ok: true, data: result.data.stdout.trim() }
  }

  /**
   * §48.2 (a0): establish the trusted agent-profiles root for a runtime.
   * Missing → create it outright (the path is fully Teskra-determined).
   * Present → must be a real directory, never a symlink/reparse point;
   * anything else rejects ALL profile writes for that runtime.
   */
  const ensureTrustedRoot = async (runtime: WorkspaceRuntime): Promise<IpcResult<string>> => {
    const key = runtimeKey(runtime.ref)
    const cached = trustedRoots.get(key)
    if (cached !== undefined) {
      return { ok: true, data: cached }
    }
    const root = runtime.resolveAgentProfilesRoot()

    // §48.2 (a0) / P1-5: when WSL detection could not probe the distro home,
    // the root degrades to a literal `~/.teskra/...` that no shell expands —
    // any fs operation would create a literal `~` directory in the wsl.exe
    // cwd and poison trustedRoots for the rest of the process. Fail fast
    // BEFORE any fs side effect and never cache a non-absolute root.
    // The flavor check accepts both absolute forms: host-native runtimes use
    // the HOST path flavor (a "wsl" workspace on a Linux dev host resolves
    // host paths, and tests run that configuration on win32 hosts too); only
    // the degraded `~/...` fallback is absolute in neither flavor.
    if (!win32.isAbsolute(root) && !posix.isAbsolute(root)) {
      return fail({
        code: 'WSL_DISTRO_NOT_FOUND',
        message:
          "The WSL distribution's home directory is unknown. Re-run WSL detection, then try again.",
        retryable: true,
        detail: `resolveAgentProfilesRoot() returned the non-absolute fallback ${JSON.stringify(root)} for runtime ${key}`,
      })
    }

    if (runtime.hostNative) {
      try {
        const stat = lstatSync(root)
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          return fail({
            code: 'VALIDATION_FAILED',
            message:
              'The agent-profiles directory is not a plain directory; refusing all profile writes.',
            retryable: false,
            detail: `trusted root ${root} is ${stat.isSymbolicLink() ? 'a symlink' : 'not a directory'}`,
          })
        }
        const canonical = realpathSync(root)
        trustedRoots.set(key, canonical)
        return { ok: true, data: canonical }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
          return fail({
            code: 'UNKNOWN',
            message: 'Failed to inspect the agent-profiles directory.',
            retryable: true,
            detail: `lstat ${root}`,
            cause,
          })
        }
      }
      try {
        mkdirSync(root, { recursive: true })
        const canonical = realpathSync(root)
        trustedRoots.set(key, canonical)
        return { ok: true, data: canonical }
      } catch (cause) {
        return fail({
          code: 'UNKNOWN',
          message: 'Failed to create the agent-profiles directory.',
          retryable: true,
          detail: `mkdir ${root}`,
          cause,
        })
      }
    }

    // WSL-on-Windows: the root lives inside the distro filesystem (§48.2 (b)).
    const exists = await runFs(runtime, 'test', ['-e', root])
    if (!exists.ok) {
      return exists
    }
    if (exists.data.exitCode !== 0) {
      const created = await runFsChecked(runtime, 'create', 'mkdir', ['-p', '--', root])
      if (!created.ok) {
        return created
      }
    } else {
      const isDirectory = await runFs(runtime, 'test', ['-d', root])
      if (!isDirectory.ok) {
        return isDirectory
      }
      const isSymlink = await runFs(runtime, 'test', ['-L', root])
      if (!isSymlink.ok) {
        return isSymlink
      }
      if (isDirectory.data.exitCode !== 0 || isSymlink.data.exitCode === 0) {
        return fail({
          code: 'VALIDATION_FAILED',
          message:
            'The agent-profiles directory is not a plain directory; refusing all profile writes.',
          retryable: false,
          detail: `trusted root ${root} failed directory/symlink checks in distro`,
        })
      }
    }
    const canonical = await runFsChecked(runtime, 'resolve', 'realpath', ['-m', '--', root])
    if (!canonical.ok) {
      return canonical
    }
    trustedRoots.set(key, canonical.data)
    return canonical
  }

  /**
   * §48.2 (a): create a managed profile home under the trusted root —
   * nearest-existing-ancestor realpath containment check, create, then a
   * second realpath check to close the check-to-create race window.
   */
  const createManagedHome = async (
    runtime: WorkspaceRuntime,
    trustedRoot: string,
    home: string,
  ): Promise<IpcResult<void>> => {
    const caseInsensitive = runtime.ref.kind === 'windows'

    if (runtime.hostNative) {
      try {
        let ancestor = home
        while (!existsSync(ancestor)) {
          const parent = dirname(ancestor)
          if (parent === ancestor) {
            return fail({
              code: 'VALIDATION_FAILED',
              message: 'The profile home path escapes the Teskra agent-profiles directory.',
              retryable: false,
              detail: `no existing ancestor for ${home}`,
            })
          }
          ancestor = parent
        }
        if (!isWithinRoot(trustedRoot, realpathSync(ancestor), caseInsensitive)) {
          return fail({
            code: 'VALIDATION_FAILED',
            message: 'The profile home path escapes the Teskra agent-profiles directory.',
            retryable: false,
            detail: `ancestor ${ancestor} of ${home} resolves outside trusted root ${trustedRoot}`,
          })
        }
      } catch (cause) {
        return fail({
          code: 'UNKNOWN',
          message: 'Failed to verify the profile directory location.',
          retryable: true,
          detail: `ancestor check for ${home}`,
          cause,
        })
      }
      const created = deps.paths.createAgentProfileHome(home)
      if (!created.ok) {
        return created
      }
      try {
        if (!isWithinRoot(trustedRoot, realpathSync(home), caseInsensitive)) {
          return fail({
            code: 'VALIDATION_FAILED',
            message: 'The profile home path escapes the Teskra agent-profiles directory.',
            retryable: false,
            detail: `post-create realpath ${home} resolves outside trusted root ${trustedRoot}`,
          })
        }
      } catch (cause) {
        return fail({
          code: 'UNKNOWN',
          message: 'Failed to verify the created profile directory.',
          retryable: true,
          detail: `post-create realpath ${home}`,
          cause,
        })
      }
      return { ok: true, data: undefined }
    }

    // WSL-on-Windows: realpath -m canonicalizes the existing prefix without
    // requiring the target to exist — the ancestor check and (post-create)
    // the final check in one form.
    const before = await runFsChecked(runtime, 'verify', 'realpath', ['-m', '--', home])
    if (!before.ok) {
      return before
    }
    if (!isWithinRoot(trustedRoot, before.data, false)) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'The profile home path escapes the Teskra agent-profiles directory.',
        retryable: false,
        detail: `${home} resolves to ${before.data}, outside trusted root ${trustedRoot}`,
      })
    }
    const created = await runFsChecked(runtime, 'create', 'mkdir', ['-p', '--', home])
    if (!created.ok) {
      return created
    }
    const after = await runFsChecked(runtime, 'verify', 'realpath', ['-m', '--', home])
    if (!after.ok) {
      return after
    }
    if (!isWithinRoot(trustedRoot, after.data, false)) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'The profile home path escapes the Teskra agent-profiles directory.',
        retryable: false,
        detail: `post-create ${home} resolves to ${after.data}, outside trusted root ${trustedRoot}`,
      })
    }
    return { ok: true, data: undefined }
  }

  const homeExists = async (
    runtime: WorkspaceRuntime,
    home: string,
  ): Promise<IpcResult<boolean>> => {
    if (runtime.hostNative) {
      return { ok: true, data: existsSync(home) }
    }
    const result = await runFs(runtime, 'test', ['-d', home])
    return result.ok ? { ok: true, data: result.data.exitCode === 0 } : result
  }

  /** §48: only ever called for managed homes verified inside the trusted root. */
  const deleteManagedHome = async (
    runtime: WorkspaceRuntime,
    trustedRoot: string,
    home: string,
  ): Promise<IpcResult<void>> => {
    const caseInsensitive = runtime.ref.kind === 'windows'
    if (runtime.hostNative) {
      if (!existsSync(home)) {
        return { ok: true, data: undefined }
      }
      try {
        const canonical = realpathSync(home)
        if (
          !isWithinRoot(trustedRoot, canonical, caseInsensitive) ||
          !hasManagedHomeDepth(trustedRoot, canonical, caseInsensitive)
        ) {
          return fail({
            code: 'VALIDATION_FAILED',
            message: 'Refusing to delete a directory outside the Teskra agent-profiles directory.',
            retryable: false,
            detail: `${home} resolves to ${canonical}, which is not a <root>/<agentId>/<slug> home under trusted root ${trustedRoot}`,
          })
        }
        rmSync(home, { recursive: true, force: true })
        return { ok: true, data: undefined }
      } catch (cause) {
        return fail({
          code: 'UNKNOWN',
          message: 'Failed to delete the profile directory.',
          retryable: true,
          detail: `rm ${home}`,
          cause,
        })
      }
    }
    const canonical = await runFsChecked(runtime, 'verify', 'realpath', ['-m', '--', home])
    if (!canonical.ok) {
      return canonical
    }
    if (
      !isWithinRoot(trustedRoot, canonical.data, false) ||
      !hasManagedHomeDepth(trustedRoot, canonical.data, false)
    ) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'Refusing to delete a directory outside the Teskra agent-profiles directory.',
        retryable: false,
        detail: `${home} resolves to ${canonical.data}, which is not a <root>/<agentId>/<slug> home under trusted root ${trustedRoot}`,
      })
    }
    const removed = await runFsChecked(runtime, 'delete', 'rm', ['-rf', '--', home])
    return removed.ok ? { ok: true, data: undefined } : removed
  }

  /** Host-native guard for the windows-runtime-on-non-Windows-host case. */
  const runtimeFor = (ref: WorkspaceRuntimeRef): Promise<IpcResult<WorkspaceRuntime>> => {
    const runtime = createRuntime(ref)
    if (!runtime.ok) {
      return Promise.resolve(runtime)
    }
    const valid = runtime.data.validate()
    if (!valid.ok) {
      return Promise.resolve(valid)
    }
    return Promise.resolve(runtime)
  }

  const notFound = (id: string): IpcResult<never> =>
    fail({
      code: 'ACCOUNT_PROFILE_NOT_FOUND',
      message: 'The account profile no longer exists.',
      retryable: false,
      detail: `account profile ${id} not found`,
    })

  const isValidConcurrency = (value: number): boolean => Number.isInteger(value) && value >= 1

  const validateDraft = (draft: unknown): IpcResult<AgentAccountProfile> => {
    const parsed = agentAccountProfileSchema.safeParse(draft)
    if (!parsed.success) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'The account profile is invalid.',
        retryable: false,
        detail: JSON.stringify(parsed.error.issues),
      })
    }
    return { ok: true, data: parsed.data }
  }

  /**
   * §49 / P2-2: an external configHome is stored in the path form of ITS
   * runtime. Windows runtimes get a normalized, case-folded win32 path so the
   * per-runtime config_home unique index cannot be bypassed by case or
   * trailing-slash variants (`C:\Users\x` vs `c:\users\x\`); WSL runtimes get
   * a normalized POSIX path. A path shaped for the other runtime kind is
   * rejected outright — it could never address a home inside that runtime.
   * The windows normalization itself is normalizeWindowsConfigHome
   * (./external-config-home.ts), shared with data migration 016
   * (db/migrations/016_external_config_home_normalize.ts), which rewrites
   * legacy rows stored before this rule — so the read/update paths need no
   * compatibility fallback for un-normalized values.
   */
  const normalizeExternalConfigHome = (
    runtime: WorkspaceRuntimeRef,
    configHome: string,
  ): IpcResult<string> => {
    if (runtime.kind === 'windows') {
      if (
        !WINDOWS_DRIVE_ABSOLUTE.test(configHome) &&
        !configHome.startsWith('\\\\') &&
        !configHome.startsWith('//')
      ) {
        return fail({
          code: 'VALIDATION_FAILED',
          message:
            'A Windows account profile requires a Windows absolute path (X:\\... or \\\\server\\...).',
          retryable: false,
          detail: `configHome ${JSON.stringify(configHome)} is not a Windows-shaped absolute path`,
        })
      }
      return { ok: true, data: normalizeWindowsConfigHome(configHome) }
    }
    if (!configHome.startsWith('/')) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'A WSL account profile requires a POSIX absolute path (/...).',
        retryable: false,
        detail: `configHome ${JSON.stringify(configHome)} is not a POSIX-shaped absolute path`,
      })
    }
    const normalized = posix.normalize(configHome)
    // node:path keeps a trailing separator; the unique index must not see
    // `/home/u/.codex` and `/home/u/.codex/` as two homes.
    return { ok: true, data: normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized }
  }

  const createExternal = (
    request: CreateAccountProfileRequest,
  ): Promise<IpcResult<AgentAccountProfile>> => {
    if (request.configHome === undefined) {
      return Promise.resolve(
        fail({
          code: 'VALIDATION_FAILED',
          message: 'An external account profile requires an existing CLI home path.',
          retryable: false,
          detail: 'authType=external without configHome',
        }),
      )
    }
    const configHome = normalizeExternalConfigHome(request.runtime, request.configHome)
    if (!configHome.ok) {
      return Promise.resolve(configHome)
    }
    const clock = now()
    const draft = validateDraft({
      id: createId(),
      agentId: request.agentId,
      name: request.name,
      description: request.description,
      authType: request.authType,
      runtime: request.runtime,
      configHome: configHome.data,
      maxConcurrentRuns: request.maxConcurrentRuns,
      status: 'unknown',
      enabled: true,
      createdAt: clock,
      updatedAt: clock,
    })
    if (!draft.ok) {
      return Promise.resolve(draft)
    }
    // §49/§50.2: external homes are user-managed — no path formula, no
    // ownership-root constraint, no directory creation, no status probing.
    const created = deps.profiles.create({
      id: draft.data.id,
      agentId: draft.data.agentId,
      name: draft.data.name,
      description: draft.data.description,
      authType: draft.data.authType,
      runtime: draft.data.runtime,
      configHome: draft.data.configHome,
      maxConcurrentRuns: draft.data.maxConcurrentRuns,
      status: 'unknown',
    })
    if (!created.ok) {
      return Promise.resolve(created)
    }
    deps.events.emit('account.created', {
      profileId: created.data.id,
      agentId: created.data.agentId,
    })
    audit('account.created', created.data.id, {
      agentId: created.data.agentId,
      name: created.data.name,
      authType: created.data.authType,
    })
    return Promise.resolve(created)
  }

  const createManaged = async (
    request: CreateAccountProfileRequest,
  ): Promise<IpcResult<AgentAccountProfile>> => {
    if (request.slug === undefined) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'A managed account profile requires a directory slug.',
        retryable: false,
        detail: `authType=${request.authType} without slug`,
      })
    }
    // §48.1: NTFS folds case, so slugs are stored lowercase; the pattern
    // already restricts to lowercase — case-insensitive input is normalized,
    // anything else is rejected, never auto-suffixed.
    const slug = request.slug.toLowerCase()
    if (!ACCOUNT_PROFILE_SLUG_PATTERN.test(slug)) {
      return fail({
        code: 'VALIDATION_FAILED',
        message:
          'The profile slug must match ^[a-z0-9][a-z0-9-]{0,31}$ (lowercase letters, digits, dashes).',
        retryable: false,
        detail: `invalid slug ${JSON.stringify(request.slug)}`,
      })
    }

    const runtime = await runtimeFor(request.runtime)
    if (!runtime.ok) {
      return runtime
    }
    const trustedRoot = await ensureTrustedRoot(runtime.data)
    if (!trustedRoot.ok) {
      return trustedRoot
    }
    const home = runtime.data.resolveAgentProfileHome(request.agentId, slug)
    if (!home.ok) {
      return home
    }

    const clock = now()
    const draft = validateDraft({
      id: createId(),
      agentId: request.agentId,
      name: request.name,
      description: request.description,
      authType: request.authType,
      runtime: request.runtime,
      configHome: home.data,
      maxConcurrentRuns: request.maxConcurrentRuns ?? 1,
      status: 'login-required',
      enabled: true,
      createdAt: clock,
      updatedAt: clock,
    })
    if (!draft.ok) {
      return draft
    }

    // INSERT first: the per-runtime config_home unique index is the
    // concurrency guard (§48.1) — the loser gets CONFLICT and creates nothing.
    const created = deps.profiles.create({
      id: draft.data.id,
      agentId: draft.data.agentId,
      name: draft.data.name,
      description: draft.data.description,
      authType: draft.data.authType,
      runtime: draft.data.runtime,
      configHome: home.data,
      maxConcurrentRuns: draft.data.maxConcurrentRuns,
      status: 'login-required',
    })
    if (!created.ok) {
      if (created.error.code === 'CONFLICT') {
        return fail({
          code: 'CONFLICT',
          message: `An account profile named "${slug}" already exists for this runtime. Choose a different name.`,
          retryable: false,
          detail: `slug ${slug} already maps to configHome ${home.data}`,
        })
      }
      return created
    }

    const compensate = (error: IpcResult<never>): IpcResult<never> => {
      deps.profiles.delete(created.data.id)
      return error
    }

    const mkdir = await createManagedHome(runtime.data, trustedRoot.data, home.data)
    if (!mkdir.ok) {
      return compensate(mkdir)
    }

    const adapter = deps.adapters?.get(request.agentId)
    if (adapter?.initializeProfileHome !== undefined) {
      const initialized = await adapter.initializeProfileHome(created.data)
      if (!initialized.ok) {
        return compensate(initialized)
      }
    }

    deps.events.emit('account.created', {
      profileId: created.data.id,
      agentId: created.data.agentId,
    })
    audit('account.created', created.data.id, {
      agentId: created.data.agentId,
      name: created.data.name,
      authType: created.data.authType,
    })
    return created
  }

  const updateProfile = (
    id: string,
    patch: UpdateAccountProfileRequest,
  ): IpcResult<AgentAccountProfile> => {
    // §48.1: configHome is generated for managed profiles and immutable for
    // every profile — the field is rejected even if a caller sneaks it in.
    if (Object.prototype.hasOwnProperty.call(patch, 'configHome')) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'The configHome of an account profile cannot be changed.',
        retryable: false,
        detail: `configHome update rejected for profile ${id} (design §48.1)`,
      })
    }
    if (
      patch.maxConcurrentRuns !== undefined &&
      patch.maxConcurrentRuns !== null &&
      !isValidConcurrency(patch.maxConcurrentRuns)
    ) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: 'maxConcurrentRuns must be a positive integer (or left unset).',
        retryable: false,
        detail: `maxConcurrentRuns=${String(patch.maxConcurrentRuns)}`,
      })
    }

    const found = deps.profiles.getById(id)
    if (!found.ok) {
      return found
    }
    if (found.data === null) {
      return notFound(id)
    }
    const profile = found.data
    let touched = false

    if (patch.status !== undefined && patch.status !== profile.status) {
      const statusChanged = deps.profiles.setStatus(id, {
        status: patch.status,
        ...(patch.limitedUntil !== undefined ? { limitedUntil: patch.limitedUntil } : {}),
      })
      if (!statusChanged.ok) {
        return statusChanged
      }
      emitStatusChanged(profile, patch.status)
      touched = true
    } else if (patch.status !== undefined && patch.limitedUntil !== undefined) {
      const limited = deps.profiles.setStatus(id, {
        status: patch.status,
        limitedUntil: patch.limitedUntil,
      })
      if (!limited.ok) {
        return limited
      }
      touched = true
    }

    const fieldPatch: {
      name?: string
      description?: string | null
      maxConcurrentRuns?: number | null
      limitedUntil?: string | null
    } = {}
    if (patch.name !== undefined) {
      fieldPatch.name = patch.name
    }
    if (patch.description !== undefined) {
      fieldPatch.description = patch.description
    }
    if (patch.maxConcurrentRuns !== undefined) {
      fieldPatch.maxConcurrentRuns = patch.maxConcurrentRuns
    }
    if (patch.status === undefined && patch.limitedUntil !== undefined) {
      fieldPatch.limitedUntil = patch.limitedUntil
    }
    if (Object.keys(fieldPatch).length > 0) {
      const updated = deps.profiles.update(id, fieldPatch)
      if (!updated.ok) {
        return updated
      }
      touched = true
    }

    const final = deps.profiles.getById(id)
    if (!final.ok) {
      return final
    }
    if (final.data === null) {
      return notFound(id)
    }
    if (touched) {
      deps.events.emit('account.updated', {
        profileId: final.data.id,
        agentId: final.data.agentId,
      })
      audit('account.updated', final.data.id, {
        agentId: final.data.agentId,
        fields: Object.keys(patch).filter(
          (key) => patch[key as keyof UpdateAccountProfileRequest] !== undefined,
        ),
      })
    }
    return { ok: true, data: final.data }
  }

  const setDefaultProfile = (agentId: string, profileId: string | null): IpcResult<void> => {
    if (!deps.registry.has(agentId)) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: `Agent "${agentId}" is not registered.`,
        retryable: false,
        detail: `unknown agentId=${agentId}`,
      })
    }
    if (profileId !== null) {
      const found = deps.profiles.getById(profileId)
      if (!found.ok) {
        return found
      }
      if (found.data === null || found.data.agentId !== agentId) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'The default account profile must exist and belong to the agent.',
          retryable: false,
          detail: `default ${profileId} invalid for agent ${agentId}`,
        })
      }
      if (!found.data.enabled) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'A disabled account profile cannot be the default.',
          retryable: false,
          detail: `default ${profileId} is disabled`,
        })
      }
    }
    const updated = deps.config.updateGlobal({
      agents: { defaultAccountProfiles: { [agentId]: profileId } },
    })
    return updated.ok ? { ok: true, data: undefined } : updated
  }

  const getDefaultProfile = (agentId: string): IpcResult<string | undefined> => {
    const resolved = deps.config.resolve()
    if (!resolved.ok) {
      return resolved
    }
    const value = resolved.data.config.agents.defaultAccountProfiles[agentId]
    return { ok: true, data: value ?? undefined }
  }

  const manager: AccountProfileManager = {
    async list(filter) {
      // §18.0: sweeping BEFORE the read keeps status filtering truthful — an
      // expired `limited` row must never survive a list() as `limited`.
      if (deps.status !== undefined) {
        const swept = await deps.status.sweepExpiredLimited()
        if (!swept.ok) {
          return swept
        }
      }
      return deps.profiles.list(filter)
    },

    get(id) {
      const found = deps.profiles.getById(id)
      if (!found.ok || found.data === null || deps.status === undefined) {
        return Promise.resolve(found)
      }
      return Promise.resolve(deps.status.degradeExpiredLimited(found.data))
    },

    async create(request) {
      if (!deps.registry.has(request.agentId)) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Agent "${request.agentId}" is not registered.`,
          retryable: false,
          detail: `unknown agentId=${request.agentId}`,
        })
      }
      // §35: api-key profiles are out of the first phase — rejected at the
      // Manager, not merely hidden in the UI.
      if (request.authType === 'api-key') {
        return fail({
          code: 'CAPABILITY_NOT_AVAILABLE',
          message: 'API-key account profiles are not supported yet.',
          retryable: false,
          detail: 'authType=api-key rejected (design §35)',
        })
      }
      if (
        request.maxConcurrentRuns !== undefined &&
        !isValidConcurrency(request.maxConcurrentRuns)
      ) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'maxConcurrentRuns must be a positive integer (or left unset).',
          retryable: false,
          detail: `maxConcurrentRuns=${String(request.maxConcurrentRuns)}`,
        })
      }
      return request.authType === 'external' ? createExternal(request) : createManaged(request)
    },

    update(id, patch) {
      return Promise.resolve(updateProfile(id, patch))
    },

    async remove(id, options = {}) {
      const found = deps.profiles.getById(id)
      if (!found.ok) {
        return found
      }
      if (found.data === null) {
        return notFound(id)
      }
      const profile = found.data

      // §47.2 (4): never disable while a non-terminal run references the
      // profile — disabling must not silently kill or strand a running agent.
      const referencing = deps.runs.listByAccountProfile(id)
      if (!referencing.ok) {
        return referencing
      }
      const active = referencing.data.filter((run) => !TERMINAL_RUN_STATUSES.has(run.status))
      if (active.length > 0) {
        return fail({
          code: 'CONFLICT',
          message: `Account profile "${profile.name}" still has ${String(active.length)} active run(s). Cancel them or wait for them to finish.`,
          retryable: false,
          detail: `profile ${id} referenced by non-terminal runs ${active.map((run) => run.id).join(', ')}`,
        })
      }

      if (options.deleteHome === true) {
        // §48.2: external homes are user-managed; the option is unavailable,
        // not merely guarded. Rejected BEFORE any mutation so the profile is
        // left untouched.
        if (profile.authType === 'external') {
          return fail({
            code: 'VALIDATION_FAILED',
            message:
              'The home of an external account profile is managed outside Teskra and cannot be deleted.',
            retryable: false,
            detail: `deleteHome rejected for external profile ${id}`,
          })
        }
      }

      // §47.2 (1): disabling the default profile clears the default — never
      // leave the default pointing at a disabled profile, never refuse.
      const currentDefault = await manager.getDefault(profile.agentId)
      if (!currentDefault.ok) {
        return currentDefault
      }
      if (currentDefault.data === id) {
        const cleared = await manager.setDefault(profile.agentId, null)
        if (!cleared.ok) {
          return cleared
        }
      }

      const disabled = deps.profiles.disable(id)
      if (!disabled.ok) {
        return disabled
      }
      if (disabled.data === null) {
        return notFound(id)
      }
      deps.events.emit('account.updated', {
        profileId: disabled.data.id,
        agentId: disabled.data.agentId,
      })

      // P2-3: deleting the home is the only IRREVERSIBLE step, so it runs
      // last — after the default was cleared and the row disabled. A failure
      // here leaves a disabled profile with a leftover home (recoverable),
      // never an enabled profile without one.
      let homeDeleted = false
      if (options.deleteHome === true && profile.configHome !== undefined) {
        const runtime = await runtimeFor(profile.runtime)
        if (!runtime.ok) {
          audit('account.updated', disabled.data.id, {
            agentId: disabled.data.agentId,
            enabled: false,
          })
          return runtime
        }
        const trustedRoot = await ensureTrustedRoot(runtime.data)
        if (!trustedRoot.ok) {
          audit('account.updated', disabled.data.id, {
            agentId: disabled.data.agentId,
            enabled: false,
          })
          return trustedRoot
        }
        const deleted = await deleteManagedHome(runtime.data, trustedRoot.data, profile.configHome)
        if (!deleted.ok) {
          audit('account.updated', disabled.data.id, {
            agentId: disabled.data.agentId,
            enabled: false,
          })
          return deleted
        }
        homeDeleted = true
      }

      audit('account.updated', disabled.data.id, {
        agentId: disabled.data.agentId,
        enabled: false,
        ...(homeDeleted ? { homeDeleted: true } : {}),
      })
      return { ok: true, data: disabled.data }
    },

    async enable(id) {
      const found = deps.profiles.getById(id)
      if (!found.ok) {
        return found
      }
      if (found.data === null) {
        return notFound(id)
      }
      const profile = found.data
      if (profile.enabled) {
        return { ok: true, data: profile }
      }

      // §47.2 (3): a managed home that went missing is rebuilt and the
      // profile goes to login-required (NOT unknown — an empty home provably
      // needs a login, and unknown would read as "maybe usable").
      if (profile.authType !== 'external' && profile.configHome !== undefined) {
        const runtime = await runtimeFor(profile.runtime)
        if (!runtime.ok) {
          return runtime
        }
        const trustedRoot = await ensureTrustedRoot(runtime.data)
        if (!trustedRoot.ok) {
          return trustedRoot
        }
        const exists = await homeExists(runtime.data, profile.configHome)
        if (!exists.ok) {
          return exists
        }
        if (!exists.data) {
          const rebuilt = await createManagedHome(
            runtime.data,
            trustedRoot.data,
            profile.configHome,
          )
          if (!rebuilt.ok) {
            return rebuilt
          }
          const statusChanged = deps.profiles.setStatus(id, { status: 'login-required' })
          if (!statusChanged.ok) {
            return statusChanged
          }
          emitStatusChanged(profile, 'login-required')
        }
      }

      const enabled = deps.profiles.setEnabled(id, true)
      if (!enabled.ok) {
        return enabled
      }
      if (enabled.data === null) {
        return notFound(id)
      }
      deps.events.emit('account.updated', {
        profileId: enabled.data.id,
        agentId: enabled.data.agentId,
      })
      audit('account.updated', enabled.data.id, {
        agentId: enabled.data.agentId,
        enabled: true,
      })
      const final = deps.profiles.getById(id)
      if (!final.ok) {
        return final
      }
      return final.data === null ? notFound(id) : { ok: true, data: final.data }
    },

    setDefault(agentId, profileId) {
      return Promise.resolve(setDefaultProfile(agentId, profileId))
    },

    getDefault(agentId) {
      return Promise.resolve(getDefaultProfile(agentId))
    },

    async resolve(agentId, workspaceRuntime, explicitProfileId) {
      return resolver.resolve(agentId, workspaceRuntime, explicitProfileId)
    },

    adapterFor(agentId) {
      return deps.adapters?.get(agentId)
    },

    reservedEnvKeys() {
      if (deps.adapters === undefined) {
        return []
      }
      return [...new Set(deps.adapters.list().flatMap((adapter) => adapter.reservedEnvKeys))]
    },
  }

  return manager
}
