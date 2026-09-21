import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { posix, win32 } from 'node:path'

import type {
  AccountLoginSession,
  AgentAccountProfile,
  IpcResult,
  WorkbenchEvents,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'

import type { AccountEventRepository, AccountProfileRepository } from '../../db/repositories'
import type { EventBus } from '../../events/event-bus'
import { type InternalAppError, toPublicError } from '../../errors'
import { getLogger } from '../../logger'
import type { CommandRunner } from '../../process/command-runner'
import type { ProcessManager } from '../../process/process-manager'
import { createWorkspaceRuntime, type WorkspaceRuntime } from '../../workspace/runtime'
import type { AccountProfileAdapterRegistry } from './account-profile-adapter'

/**
 * AccountLoginService (TASK-102, Milestone 24 §24) — the interactive Login
 * Terminal backend.
 *
 * §24.1: the Renderer submits ONLY a profileId; the login argv comes from the
 * account adapter's buildLoginCommand() and the env from
 * buildRuntimeProjection() — both argv arrays, never a shell string. The
 * process is spawned through ProcessManager, the same path Agent runs take.
 *
 * §24.2 session semantics:
 *
 * - start() resolves IMMEDIATELY with the session handle — the OAuth/device
 *   flow runs in the spawned CLI and streams via account.login.output.
 * - Mutex: one login session per profileId; a repeated start returns the
 *   existing session instead of spawning a second process.
 * - Timeout: Main owns a per-session timer (never relies on the Renderer to
 *   cancel); a timed-out session is stopped like a cancel.
 * - cancel: stops the process and leaves Profile.status at its pre-login
 *   value (no detect, never writes expired).
 * - Only a NATURAL exit runs the post-exit detect that updates Profile.status.
 * - dispose() stops every session (P0-2) — no orphaned login processes.
 * - External profiles (§49) are refused: Teskra never modifies the login
 *   state of a home it does not manage.
 *
 * The service also owns detectProfileStatus() — the "probe with the adapter,
 * persist, emit account.status_changed" sequence — shared by the post-exit
 * path and the teskra:account:detect channel.
 */

/** §24.2: OAuth device flows take minutes — 10 minutes, then Main cleans up. */
export const ACCOUNT_LOGIN_SESSION_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Per-profile login working directory under the runtime's data root
 * (P2-13): the login PTY must NOT run with cwd = configHome, because the
 * CLI treats its cwd as a PROJECT directory — Claude Code would write a
 * project-level `.claude/` into the account Home it is logging into.
 */
export const ACCOUNT_LOGIN_WORKDIR_NAME = 'account-logins'

/** One-shot mkdir probe budget for the WSL login workdir; mirrors the manager. */
const LOGIN_WORKDIR_TIMEOUT_MS = 10_000

type LoginProcesses = Pick<ProcessManager, 'start' | 'write' | 'resize' | 'stop'>

export interface AccountLoginService {
  start(request: { profileId: string }): Promise<IpcResult<AccountLoginSession>>
  write(sessionId: string, data: string): IpcResult<void>
  resize(sessionId: string, cols: number, rows: number): IpcResult<void>
  cancel(sessionId: string): Promise<IpcResult<void>>
  /** §24: probe the profile through its adapter and persist the new status. */
  detectProfileStatus(profileId: string): Promise<IpcResult<AgentAccountProfile>>
  /** Active session for a profile, when one exists (mutex introspection). */
  sessionForProfile(profileId: string): AccountLoginSession | undefined
  /** P0-2: stop every active login process, then detach event forwarding. */
  dispose(): Promise<void>
}

export interface AccountLoginServiceDeps {
  readonly profiles: Pick<AccountProfileRepository, 'getById' | 'setStatus'>
  readonly adapters: Pick<AccountProfileAdapterRegistry, 'get'>
  readonly processes: LoginProcesses
  readonly events: EventBus<WorkbenchEvents>
  /**
   * TASK-116 (§41): audit sink for account.login_started /
   * account.login_verified / account.status_changed. Append failures are
   * logged, never fatal — the login session stands.
   */
  readonly accountEvents?: Pick<AccountEventRepository, 'append'> | undefined
  readonly createRuntime?: ((ref: WorkspaceRuntimeRef) => IpcResult<WorkspaceRuntime>) | undefined
  /**
   * WSL-on-Windows only: creates the per-profile login working directory
   * inside the distro filesystem (argv-array `mkdir -p --`, the same
   * mechanism the AccountProfileManager uses). Without a runner a WSL login
   * session is refused with CAPABILITY_NOT_AVAILABLE.
   */
  readonly commands?: CommandRunner | undefined
  readonly createId?: (() => string) | undefined
  readonly now?: (() => string) | undefined
  /** Test seam; production uses ACCOUNT_LOGIN_SESSION_TIMEOUT_MS. */
  readonly sessionTimeoutMs?: number | undefined
}

interface ActiveLogin {
  readonly session: AccountLoginSession
  readonly processId: string
  readonly profileId: string
  timer: NodeJS.Timeout | undefined
  /** cancel / timeout / dispose — the post-exit detect is skipped. */
  settled: boolean
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function profileNotFound<T>(profileId: string): IpcResult<T> {
  return fail({
    code: 'ACCOUNT_PROFILE_NOT_FOUND',
    message: 'The account profile no longer exists.',
    retryable: false,
    detail: `account profile ${JSON.stringify(profileId)} not found`,
  })
}

function sessionNotFound<T>(sessionId: string): IpcResult<T> {
  return fail({
    code: 'VALIDATION_FAILED',
    message: 'The account login session is not active.',
    retryable: false,
    detail: `login registry has no entry for ${JSON.stringify(sessionId)}`,
  })
}

export function createAccountLoginService(deps: AccountLoginServiceDeps): AccountLoginService {
  const sessions = new Map<string, ActiveLogin>()
  const sessionByProfile = new Map<string, string>()
  const sessionByProcess = new Map<string, string>()
  const now = deps.now ?? ((): string => new Date().toISOString())
  const createId = deps.createId ?? ((): string => randomUUID())
  const createRuntime =
    deps.createRuntime ??
    ((ref: WorkspaceRuntimeRef): IpcResult<WorkspaceRuntime> => createWorkspaceRuntime(ref))
  const sessionTimeoutMs = deps.sessionTimeoutMs ?? ACCOUNT_LOGIN_SESSION_TIMEOUT_MS
  const logger = getLogger('account')

  /** TASK-116 (§41): best-effort audit append — failures are logged, never fatal. */
  const audit = (eventType: string, profileId: string, payload: Record<string, unknown>): void => {
    if (deps.accountEvents === undefined) {
      return
    }
    const appended = deps.accountEvents.append({ profileId, eventType, payload }, now())
    if (!appended.ok) {
      logger.error(
        { profileId, eventType, error: appended.error },
        'Failed to persist the account audit event.',
      )
    }
  }

  /** Removes the session from every index and disarms its timeout. */
  const forget = (sessionId: string): ActiveLogin | undefined => {
    const entry = sessions.get(sessionId)
    if (entry === undefined) {
      return undefined
    }
    sessions.delete(sessionId)
    sessionByProfile.delete(entry.profileId)
    sessionByProcess.delete(entry.processId)
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    return entry
  }

  const detectProfileStatus = async (
    profileId: string,
  ): Promise<IpcResult<AgentAccountProfile>> => {
    const found = deps.profiles.getById(profileId)
    if (!found.ok) {
      return found
    }
    if (found.data === null) {
      return profileNotFound(profileId)
    }
    const profile = found.data
    const adapter = deps.adapters.get(profile.agentId)
    if (adapter === undefined) {
      return fail({
        code: 'CAPABILITY_NOT_AVAILABLE',
        message: `Agent "${profile.agentId}" has no account profile adapter.`,
        retryable: false,
        detail: `no AgentAccountProfileAdapter registered for agentId=${profile.agentId}`,
      })
    }
    const detection = await adapter.detectStatus(profile)
    if (!detection.ok) {
      return detection
    }
    const updated = deps.profiles.setStatus(profileId, {
      status: detection.data.status,
      ...(detection.data.limitedUntil !== undefined
        ? { limitedUntil: detection.data.limitedUntil }
        : {}),
    })
    if (!updated.ok) {
      return updated
    }
    if (updated.data === null) {
      return profileNotFound(profileId)
    }
    if (detection.data.status !== profile.status) {
      deps.events.emit('account.status_changed', {
        profileId,
        agentId: profile.agentId,
        status: detection.data.status,
        previousStatus: profile.status,
      })
      audit('account.status_changed', profileId, {
        agentId: profile.agentId,
        status: detection.data.status,
        previousStatus: profile.status,
      })
    }
    return { ok: true, data: updated.data }
  }

  /** §24: only a natural (non-cancelled) exit probes and updates the status. */
  const detectAfterExit = (profileId: string): void => {
    void detectProfileStatus(profileId).then((result) => {
      if (!result.ok) {
        logger.warn(
          { profileId, error: result.error },
          'Post-login status detection failed; profile status left unchanged.',
        )
        return
      }
      // §41: a login session that ends with a verified CLI Home is the only
      // writer of account.login_verified — a manual detect never writes it.
      if (result.data.status === 'ready') {
        audit('account.login_verified', profileId, {
          agentId: result.data.agentId,
          status: 'ready',
        })
      }
    })
  }

  const unsubscribeOutput = deps.events.subscribe('process.output', ({ processId, data }) => {
    const sessionId = sessionByProcess.get(processId)
    if (sessionId !== undefined) {
      deps.events.emit('account.login.output', { sessionId, data })
    }
  })
  const unsubscribeExit = deps.events.subscribe('process.exited', ({ processId, exitCode }) => {
    const sessionId = sessionByProcess.get(processId)
    if (sessionId === undefined) {
      return
    }
    const entry = forget(sessionId)
    if (entry === undefined) {
      return
    }
    deps.events.emit('account.login.exited', { sessionId, exitCode })
    if (!entry.settled) {
      detectAfterExit(entry.profileId)
    }
  })

  /** cancel / timeout: stop the process, keep the pre-login profile status. */
  const stopSession = async (sessionId: string): Promise<IpcResult<void>> => {
    const entry = sessions.get(sessionId)
    if (entry === undefined) {
      return sessionNotFound(sessionId)
    }
    // Mark BEFORE stopping so the process.exited handler (synchronous EventBus)
    // skips the post-exit detect.
    entry.settled = true
    const stopped = await deps.processes.stop(entry.processId)
    if (!stopped.ok) {
      // The process may have exited on its own between the lookup and the
      // stop; the exited handler has then already finalized the session.
      if (sessions.has(sessionId)) {
        forget(sessionId)
      }
      return stopped
    }
    // Real ProcessManager.stop awaits the exit, so process.exited has already
    // finalized the session; forget() is the defensive path for fakes that do
    // not emit it.
    if (sessions.has(sessionId)) {
      forget(sessionId)
      deps.events.emit('account.login.exited', {
        sessionId,
        exitCode: stopped.data.exit.exitCode,
      })
    }
    return { ok: true, data: undefined }
  }

  /**
   * P2-13: the login PTY's working directory is a dedicated per-profile
   * directory under the runtime's data root (resolved through the
   * WorkspaceRuntime / paths abstraction, never hand-built), created before
   * spawn. Running the login with cwd = configHome made the CLI treat the
   * account Home as a project directory — Claude Code writes a project-level
   * `.claude/` into its cwd.
   */
  const ensureLoginWorkdir = async (
    profile: AgentAccountProfile,
    runtime: WorkspaceRuntime,
  ): Promise<IpcResult<string>> => {
    const root = runtime.resolveDataRoot()
    // Mirror the AccountProfileManager's guard: when WSL detection could not
    // probe the distro home, the data root degrades to a literal `~/...`
    // that no shell expands — creating directories there would litter a
    // literal `~` directory into the wsl.exe cwd. Fail fast instead.
    if (!win32.isAbsolute(root) && !posix.isAbsolute(root)) {
      return fail({
        code: 'WSL_DISTRO_NOT_FOUND',
        message:
          "The WSL distribution's home directory is unknown. Re-run WSL detection, then try again.",
        retryable: true,
        detail: `resolveDataRoot() returned the non-absolute fallback ${JSON.stringify(root)}; cannot resolve the login working directory for profile ${profile.id}`,
      })
    }
    const workdir =
      runtime.ref.kind === 'windows'
        ? win32.join(root, ACCOUNT_LOGIN_WORKDIR_NAME, profile.id)
        : posix.join(root, ACCOUNT_LOGIN_WORKDIR_NAME, profile.id)

    if (runtime.hostNative) {
      try {
        mkdirSync(workdir, { recursive: true })
        return { ok: true, data: workdir }
      } catch (cause) {
        return fail({
          code: 'UNKNOWN',
          message: 'Failed to create the login working directory.',
          retryable: true,
          detail: `mkdir ${workdir}`,
          cause,
        })
      }
    }

    // WSL-on-Windows: the workdir lives inside the distro filesystem —
    // argv-array mkdir, never a shell string.
    if (deps.commands === undefined) {
      return fail({
        code: 'CAPABILITY_NOT_AVAILABLE',
        message: 'WSL login sessions cannot be prepared without a command runner.',
        retryable: false,
        detail: 'AccountLoginService has no CommandRunner for WSL-on-Windows fs operations',
      })
    }
    const created = await deps.commands.run({
      command: 'mkdir',
      args: ['-p', '--', workdir],
      runtime,
      timeoutMs: LOGIN_WORKDIR_TIMEOUT_MS,
    })
    if (!created.ok) {
      return created
    }
    if (created.data.exitCode !== 0) {
      return fail({
        code: 'UNKNOWN',
        message: 'Failed to create the login working directory.',
        retryable: true,
        detail: `mkdir -p -- ${workdir} exited ${String(created.data.exitCode)}: ${created.data.stderr.trim()}`,
      })
    }
    return { ok: true, data: workdir }
  }

  // ProcessManager.start itself is sync, but preparing the login working
  // directory may await a WSL mkdir, so the whole body is async.
  const startSession = async ({
    profileId,
  }: {
    profileId: string
  }): Promise<IpcResult<AccountLoginSession>> => {
    const existing = sessionByProfile.get(profileId)
    if (existing !== undefined) {
      const entry = sessions.get(existing)
      if (entry !== undefined) {
        return { ok: true, data: entry.session }
      }
    }

    const found = deps.profiles.getById(profileId)
    if (!found.ok) {
      return found
    }
    if (found.data === null) {
      return profileNotFound(profileId)
    }
    const profile = found.data
    // A disabled profile must not acquire new credentials: enabling it again
    // is the explicit user gesture that re-activates the account.
    if (!profile.enabled) {
      return fail({
        code: 'ACCOUNT_PROFILE_DISABLED',
        message: 'This account profile is disabled. Enable it before signing in.',
        retryable: false,
        detail: `login rejected for disabled profile ${profileId}`,
      })
    }
    // §49: an external home is managed outside Teskra — the login terminal
    // would run the CLI's login flow against it and rewrite its auth files,
    // so Teskra refuses to start a login session for it at all.
    if (profile.authType === 'external') {
      return fail({
        code: 'VALIDATION_FAILED',
        message:
          'This account profile is managed externally — sign in with the CLI directly, outside Teskra.',
        retryable: false,
        detail: `login rejected for external profile ${profileId} (design §49)`,
      })
    }
    const adapter = deps.adapters.get(profile.agentId)
    if (adapter === undefined) {
      return fail({
        code: 'CAPABILITY_NOT_AVAILABLE',
        message: `Agent "${profile.agentId}" has no account profile adapter.`,
        retryable: false,
        detail: `no AgentAccountProfileAdapter registered for agentId=${profile.agentId}`,
      })
    }
    const command = adapter.buildLoginCommand(profile)
    if (!command.ok) {
      return command
    }
    const runtime = createRuntime(profile.runtime)
    if (!runtime.ok) {
      return runtime
    }
    const valid = runtime.data.validate()
    if (!valid.ok) {
      return valid
    }
    const projection = adapter.buildRuntimeProjection(profile, runtime.data)
    if (!projection.ok) {
      return projection
    }
    const workdir = await ensureLoginWorkdir(profile, runtime.data)
    if (!workdir.ok) {
      return workdir
    }
    // The async workdir preparation opened a window for a concurrent start
    // for the same profile — re-check the mutex before registering.
    const raced = sessionByProfile.get(profileId)
    if (raced !== undefined) {
      const entry = sessions.get(raced)
      if (entry !== undefined) {
        return { ok: true, data: entry.session }
      }
    }

    const session: AccountLoginSession = {
      sessionId: createId(),
      profileId,
      startedAt: now(),
    }
    const processId = createId()
    const entry: ActiveLogin = { session, processId, profileId, timer: undefined, settled: false }
    // Register before spawning so even immediate process output/exit can be
    // mapped to this session instead of being lost.
    sessions.set(session.sessionId, entry)
    sessionByProfile.set(profileId, session.sessionId)
    sessionByProcess.set(processId, session.sessionId)

    const started = deps.processes.start({
      id: processId,
      command: command.data.command,
      args: command.data.args,
      // codex/claude login is a global CLI operation against the profile's
      // CLI Home (CODEX_HOME / CLAUDE_CONFIG_DIR via env), not a workspace
      // operation — no worktree, no workspaceId. The cwd is a dedicated
      // per-profile login directory under the data root (P2-13): running
      // with cwd = configHome made the CLI treat the account Home as a
      // project directory (Claude Code writes a project-level `.claude/`
      // into its cwd).
      cwd: workdir.data,
      env: projection.data.env,
      runtime: runtime.data,
    })
    if (!started.ok) {
      forget(session.sessionId)
      return started
    }

    audit('account.login_started', profileId, {
      agentId: profile.agentId,
      sessionId: session.sessionId,
    })
    // §24.2: Main-side timeout — never rely on the Renderer to cancel.
    entry.timer = setTimeout(() => {
      void stopSession(session.sessionId).then((result) => {
        if (!result.ok) {
          logger.warn(
            { sessionId: session.sessionId, error: result.error },
            'Timed-out login session did not stop cleanly.',
          )
        }
      })
    }, sessionTimeoutMs)
    entry.timer.unref?.()

    return { ok: true, data: session }
  }

  const service: AccountLoginService = {
    start(request) {
      return startSession(request)
    },

    write(sessionId, data) {
      const entry = sessions.get(sessionId)
      return entry === undefined
        ? sessionNotFound(sessionId)
        : deps.processes.write(entry.processId, data)
    },

    resize(sessionId, cols, rows) {
      const entry = sessions.get(sessionId)
      return entry === undefined
        ? sessionNotFound(sessionId)
        : deps.processes.resize(entry.processId, cols, rows)
    },

    cancel(sessionId) {
      return stopSession(sessionId)
    },

    detectProfileStatus(profileId) {
      return detectProfileStatus(profileId)
    },

    sessionForProfile(profileId) {
      const sessionId = sessionByProfile.get(profileId)
      return sessionId === undefined ? undefined : sessions.get(sessionId)?.session
    },

    async dispose() {
      // P0-2: stop every login process while the event subscriptions are still
      // live, so process.exited finalizes sessions (settled → no detect)
      // instead of leaving stale state behind.
      const active = [...sessions.values()]
      for (const entry of active) {
        entry.settled = true
      }
      await Promise.all(
        active.map(async (entry) => {
          const stopped = await deps.processes.stop(entry.processId)
          if (!stopped.ok) {
            logger.error(
              { sessionId: entry.session.sessionId, error: stopped.error },
              'Failed to stop a login session during shutdown.',
            )
          }
          forget(entry.session.sessionId)
        }),
      )
      unsubscribeOutput()
      unsubscribeExit()
      sessions.clear()
      sessionByProfile.clear()
      sessionByProcess.clear()
    },
  }

  return service
}
