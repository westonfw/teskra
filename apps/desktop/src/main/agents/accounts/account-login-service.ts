import { randomUUID } from 'node:crypto'

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

  // Synchronous body (ProcessManager.start is sync); the interface returns a
  // Promise so the IPC facade shape stays uniform.
  const startSession = ({ profileId }: { profileId: string }): IpcResult<AccountLoginSession> => {
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
      // operation — no worktree, no workspaceId. The profile's configHome is
      // the minimal guaranteed-to-exist cwd; an external profile without one
      // simply inherits the runtime default cwd.
      ...(profile.configHome === undefined ? {} : { cwd: profile.configHome }),
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
      return Promise.resolve(startSession(request))
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
