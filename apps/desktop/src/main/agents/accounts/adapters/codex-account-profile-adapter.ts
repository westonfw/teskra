import type { AgentAccountProfile, IpcResult, WorkspaceRuntimeRef } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from '../../../errors'
import type { CommandRunner } from '../../../process/command-runner'
import type { WorkspaceRuntime } from '../../../workspace/runtime'
import { CODEX_AGENT } from '../../definitions/codex'
import type {
  AccountProfileAdapterRegistry,
  AccountProfileLoginCommand,
  AccountProfileRuntimeProjection,
  AccountProfileStatusDetection,
  AgentAccountProfileAdapter,
} from '../account-profile-adapter'
import { defaultRuntimeFactory, probeRuntimeFileExists } from './runtime-file-probe'

/**
 * CodexAccountProfileAdapter (TASK-098, Milestone 24 §10) — the Codex side of
 * "account = environment": every account profile owns a full Codex Home and a
 * Run is projected with `CODEX_HOME=<profile.configHome>`.
 *
 * §10.1 projection is deliberately two steps, and this adapter performs ONLY
 * step 1: write `profile.configHome` into the env VERBATIM. §5.3 makes the
 * persisted configHome a normalized absolute path inside the profile's target
 * runtime, so resolveRuntimePath must NOT touch it (it exists for host-side
 * run artifacts; applied here it would rewrite a correct `/home/…` into a
 * wrong `/mnt/c/…`). Step 2 — WSLENV passthrough without the `/p` flag — is
 * resolveSpawnEnv's existing behavior and needs no profile code.
 *
 * §10.3: auth material is NEVER copied between homes; detectStatus probes the
 * existence of `auth.json` only, never its contents.
 */

export const CODEX_HOME_ENV_KEY = 'CODEX_HOME'

/** Codex CLI's auth state file inside CODEX_HOME — existence is the only signal used. */
const CODEX_AUTH_FILE = 'auth.json'

const DETECT_TIMEOUT_MS = 10_000

export interface CodexAccountProfileAdapterDeps {
  /** Required to probe auth files inside a WSL-on-Windows distro. */
  readonly commands?: CommandRunner
  /** Runtime factory seam (tests inject fakes; production = createWorkspaceRuntime). */
  readonly createRuntime?: (ref: WorkspaceRuntimeRef) => IpcResult<WorkspaceRuntime>
  /** Host-native existence probe seam (tests inject; production = node:fs). */
  readonly hostFileExists?: (path: string) => boolean
  /**
   * Executable resolution seam mirroring cli-agent-adapter (detection cache /
   * user override), wired by TASK-100 compose. Receives the profile so the
   * lookup can key on the profile's runtime; without it the definition's
   * bare command is used.
   */
  readonly resolveExecutable?: (profile: AgentAccountProfile) => string | undefined
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function missingConfigHome(operation: string): IpcResult<never> {
  return fail({
    code: 'VALIDATION_FAILED',
    message: 'The Codex account profile has no configHome and cannot be projected.',
    retryable: false,
    detail: `${operation}: profile without configHome (managed profiles always carry one, §5.3)`,
  })
}

export function createCodexAccountProfileAdapter(
  deps: CodexAccountProfileAdapterDeps = {},
): AgentAccountProfileAdapter {
  const createRuntime = deps.createRuntime ?? defaultRuntimeFactory

  const unknown = (): IpcResult<AccountProfileStatusDetection> => ({
    ok: true,
    data: { status: 'unknown' },
  })

  return {
    agentId: CODEX_AGENT.id,
    reservedEnvKeys: [CODEX_HOME_ENV_KEY],

    buildRuntimeProjection(profile): IpcResult<AccountProfileRuntimeProjection> {
      if (profile.agentId !== CODEX_AGENT.id) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `The account profile belongs to agent "${profile.agentId}", not Codex.`,
          retryable: false,
          detail: `CodexAccountProfileAdapter received profile ${profile.id} agentId=${profile.agentId}`,
        })
      }
      if (profile.configHome === undefined) {
        return missingConfigHome('buildRuntimeProjection')
      }
      // §10.1 step 1: verbatim, no resolveRuntimePath (see module comment).
      return { ok: true, data: { env: { [CODEX_HOME_ENV_KEY]: profile.configHome } } }
    },

    async detectStatus(profile): Promise<IpcResult<AccountProfileStatusDetection>> {
      if (profile.configHome === undefined) {
        return unknown()
      }
      const runtime = createRuntime(profile.runtime)
      if (!runtime.ok) {
        return unknown()
      }
      // §10.3: existence only, never the contents — the probe itself lives in
      // runtime-file-probe so both account adapters share one implementation.
      const probe = await probeRuntimeFileExists({
        runtime: runtime.data,
        directory: profile.configHome,
        fileName: CODEX_AUTH_FILE,
        testFlag: '-f',
        timeoutMs: DETECT_TIMEOUT_MS,
        ...(deps.commands !== undefined ? { commands: deps.commands } : {}),
        ...(deps.hostFileExists !== undefined ? { hostFileExists: deps.hostFileExists } : {}),
      })
      // A probe that RAN and did not find the file means "log in"; only a
      // probe that could not run at all is inconclusive.
      if (probe === 'unknown') {
        return unknown()
      }
      return { ok: true, data: { status: probe === 'exists' ? 'ready' : 'login-required' } }
    },

    buildLoginCommand(profile): IpcResult<AccountProfileLoginCommand> {
      if (profile.configHome === undefined) {
        return missingConfigHome('buildLoginCommand')
      }
      // argv only — never a shell string. The profile's CODEX_HOME env comes
      // from buildRuntimeProjection when the Login Terminal is launched.
      return {
        ok: true,
        data: {
          command: deps.resolveExecutable?.(profile) ?? CODEX_AGENT.executable.command,
          args: [...(CODEX_AGENT.executable.defaultArgs ?? []), 'login'],
        },
      }
    },

    // §10.2/§10.3: a fresh Codex home needs no bootstrap — and copying
    // auth.json from another home is exactly what this hook must never do.
    initializeProfileHome(): Promise<IpcResult<void>> {
      return Promise.resolve({ ok: true, data: undefined })
    },
  }
}

/**
 * Registration helper kept next to the adapter so the compose/assembly wiring
 * (TASK-100) has a single import — no other module needs to know the factory.
 */
export function registerCodexAccountProfileAdapter(
  registry: AccountProfileAdapterRegistry,
  deps: CodexAccountProfileAdapterDeps = {},
): ReturnType<AccountProfileAdapterRegistry['register']> {
  return registry.register(createCodexAccountProfileAdapter(deps))
}
