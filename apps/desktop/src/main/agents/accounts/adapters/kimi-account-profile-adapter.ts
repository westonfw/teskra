import type { AgentAccountProfile, IpcResult, WorkspaceRuntimeRef } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from '../../../errors'
import type { CommandRunner } from '../../../process/command-runner'
import type { WorkspaceRuntime } from '../../../workspace/runtime'
import { KIMI_AGENT } from '../../definitions/kimi'
import type {
  AccountProfileAdapterRegistry,
  AccountProfileLoginCommand,
  AccountProfileRuntimeProjection,
  AccountProfileStatusDetection,
  AgentAccountProfileAdapter,
} from '../account-profile-adapter'
import { defaultRuntimeFactory, probeRuntimeFileExists } from './runtime-file-probe'

/**
 * KimiAccountProfileAdapter — the Kimi Code side of "account = environment"
 * (ADR-0009), structurally identical to the Codex adapter: every account
 * profile owns a full Kimi Code home and a Run is projected with
 * `KIMI_CODE_HOME=<profile.configHome>`.
 *
 * `KIMI_CODE_HOME` overrides the CLI's data root (default `~/.kimi-code`);
 * config, OAuth credentials, and sessions all live underneath it, so it is
 * isomorphic to CODEX_HOME. The same projection rules apply (§5.3 / §10.1):
 * `profile.configHome` is already the normalized absolute path inside the
 * profile's target runtime, so it enters the env VERBATIM — resolveRuntimePath
 * is for host-side artifacts only — and WSLENV passthrough without `/p` is
 * resolveSpawnEnv's existing behavior.
 *
 * §10.3: auth material is NEVER copied between homes; detectStatus probes the
 * existence of `credentials/kimi-code.json` only, never its contents.
 */

export const KIMI_CODE_HOME_ENV_KEY = 'KIMI_CODE_HOME'

/**
 * Kimi Code's OAuth credential file inside KIMI_CODE_HOME (directory 0700 /
 * file 0600) — existence is the only signal used. The probe joins in the
 * runtime's own path flavor, so the nested relative path stays portable.
 */
const KIMI_CREDENTIALS_FILE = 'credentials/kimi-code.json'

/**
 * config.toml can carry standalone API-key credentials, so its existence
 * weakens what a MISSING credentials file means: the profile may authenticate
 * fine without OAuth material. Existence still proves nothing about validity,
 * so it maps to `unknown`, never `ready`.
 */
const KIMI_CONFIG_FILE = 'config.toml'

const DETECT_TIMEOUT_MS = 10_000

export interface KimiAccountProfileAdapterDeps {
  /** Required to probe auth files inside a WSL-on-Windows distro. */
  readonly commands?: CommandRunner
  /** Runtime factory seam (tests inject fakes; production = createWorkspaceRuntime). */
  readonly createRuntime?: (ref: WorkspaceRuntimeRef) => IpcResult<WorkspaceRuntime>
  /** Host-native existence probe seam (tests inject; production = node:fs). */
  readonly hostFileExists?: (path: string) => boolean
  /**
   * Executable resolution seam mirroring the Codex adapter (detection cache /
   * user override), wired by compose. Receives the profile so the lookup can
   * key on the profile's runtime; without it the definition's bare command is
   * used.
   */
  readonly resolveExecutable?: (profile: AgentAccountProfile) => string | undefined
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function missingConfigHome(operation: string): IpcResult<never> {
  return fail({
    code: 'VALIDATION_FAILED',
    message: 'The Kimi account profile has no configHome and cannot be projected.',
    retryable: false,
    detail: `${operation}: profile without configHome (managed profiles always carry one, §5.3)`,
  })
}

export function createKimiAccountProfileAdapter(
  deps: KimiAccountProfileAdapterDeps = {},
): AgentAccountProfileAdapter {
  const createRuntime = deps.createRuntime ?? defaultRuntimeFactory

  const unknown = (): IpcResult<AccountProfileStatusDetection> => ({
    ok: true,
    data: { status: 'unknown' },
  })

  return {
    agentId: KIMI_AGENT.id,
    reservedEnvKeys: [KIMI_CODE_HOME_ENV_KEY],

    buildRuntimeProjection(profile): IpcResult<AccountProfileRuntimeProjection> {
      if (profile.agentId !== KIMI_AGENT.id) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `The account profile belongs to agent "${profile.agentId}", not Kimi.`,
          retryable: false,
          detail: `KimiAccountProfileAdapter received profile ${profile.id} agentId=${profile.agentId}`,
        })
      }
      if (profile.configHome === undefined) {
        return missingConfigHome('buildRuntimeProjection')
      }
      // §10.1 step 1: verbatim, no resolveRuntimePath (see module comment).
      return { ok: true, data: { env: { [KIMI_CODE_HOME_ENV_KEY]: profile.configHome } } }
    },

    async detectStatus(profile): Promise<IpcResult<AccountProfileStatusDetection>> {
      if (profile.configHome === undefined) {
        return unknown()
      }
      const configHome = profile.configHome
      const runtime = createRuntime(profile.runtime)
      if (!runtime.ok) {
        return unknown()
      }
      const probe = (fileName: string): ReturnType<typeof probeRuntimeFileExists> =>
        probeRuntimeFileExists({
          runtime: runtime.data,
          directory: configHome,
          fileName,
          testFlag: '-f',
          timeoutMs: DETECT_TIMEOUT_MS,
          ...(deps.commands !== undefined ? { commands: deps.commands } : {}),
          ...(deps.hostFileExists !== undefined ? { hostFileExists: deps.hostFileExists } : {}),
        })
      // §10.3: existence only, never the contents — the probe itself lives in
      // runtime-file-probe so all account adapters share one implementation.
      const credentials = await probe(KIMI_CREDENTIALS_FILE)
      if (credentials === 'exists') {
        return { ok: true, data: { status: 'ready' } }
      }
      if (credentials === 'unknown') {
        // A probe that could not run at all is inconclusive; every other
        // outcome below follows the Codex mapping (a probe that RAN and did
        // not confirm the file means "log in", exit >= 2 included).
        return unknown()
      }
      if (credentials === 'missing') {
        // API-key users authenticate through config.toml without OAuth
        // material, so a missing credentials file is only conclusive when no
        // config.toml exists either.
        const config = await probe(KIMI_CONFIG_FILE)
        if (config === 'exists') {
          return unknown()
        }
      }
      return { ok: true, data: { status: 'login-required' } }
    },

    buildLoginCommand(profile): IpcResult<AccountProfileLoginCommand> {
      if (profile.configHome === undefined) {
        return missingConfigHome('buildLoginCommand')
      }
      // Kimi Code has no documented non-interactive login subcommand (same
      // situation as Claude): a FRESH KIMI_CODE_HOME makes the bare `kimi`
      // TUI run its official first-run onboarding (choose account / sign in),
      // and an expired profile completes `/login` in the same interactive
      // session. §24's Login Terminal is interactive by design, so launching
      // the CLI bare is the version-independent invocation; argv array, never
      // a shell string. The profile env comes from buildRuntimeProjection.
      return {
        ok: true,
        data: {
          command: deps.resolveExecutable?.(profile) ?? KIMI_AGENT.executable.command,
          args: [...(KIMI_AGENT.executable.defaultArgs ?? [])],
        },
      }
    },

    // §10.2/§10.3: a fresh Kimi home needs no bootstrap — and copying
    // credentials from another home is exactly what this hook must never do.
    initializeProfileHome(): Promise<IpcResult<void>> {
      return Promise.resolve({ ok: true, data: undefined })
    },
  }
}

/**
 * Registration helper kept next to the adapter so the compose/assembly wiring
 * has a single import — no other module needs to know the factory.
 */
export function registerKimiAccountProfileAdapter(
  registry: AccountProfileAdapterRegistry,
  deps: KimiAccountProfileAdapterDeps = {},
): ReturnType<AccountProfileAdapterRegistry['register']> {
  return registry.register(createKimiAccountProfileAdapter(deps))
}
