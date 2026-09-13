import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'

import type { AgentAccountProfile, IpcResult, WorkspaceRuntimeRef } from '@teskra/contracts'

import { toPublicError } from '../../../errors'
import type { CommandRunner } from '../../../process/command-runner'
import { createWorkspaceRuntime, type WorkspaceRuntime } from '../../../workspace/runtime'
import { CLAUDE_AGENT } from '../../definitions/claude'
import type {
  AccountProfileStatusDetection,
  AgentAccountProfileAdapter,
} from '../account-profile-adapter'

/**
 * Claude account profile adapter (TASK-099; Milestone 24 §11).
 *
 * "Account = environment" (ADR-0009): each profile owns a full Claude Code
 * config root projected as `CLAUDE_CONFIG_DIR`. That directory carries more
 * than credentials — settings, sessions, plugins, and skills live there too
 * (§11.1), so isolating it isolates the whole user-level CLI identity.
 * Project-level `CLAUDE.md` / `.claude/` still participate in config loading;
 * the AccountProfile deliberately does NOT manage project config.
 *
 * Projection rules (§5.3 / §10.1, same as CODEX_HOME):
 * - `profile.configHome` is already the normalized absolute path INSIDE the
 *   profile's target runtime, so it is written into the env VERBATIM —
 *   `resolveRuntimePath` is for host-side artifacts only and would corrupt
 *   an already-runtime-native path.
 * - WSLENV passthrough is NOT done here: ProcessManager funnels every spawn
 *   env through `resolveSpawnEnv`, which declares `CLAUDE_CONFIG_DIR` in
 *   WSLENV without `/p` (plain passthrough, correct because the value is
 *   already runtime-native).
 *
 * Registration into the adapter registry is wired in TASK-100; this module
 * only exports the factory.
 */

export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR'

/**
 * Claude Code stores its OAuth credentials at `<config dir>/.credentials.json`
 * on Windows and Linux/WSL (macOS uses the Keychain, but account profiles only
 * ship windows/wsl runtimes). We check EXISTENCE only — reading or copying
 * token material is forbidden (§10.3), so token expiry stays invisible to us
 * and surfaces as a failed Run instead (§17).
 */
const CLAUDE_CREDENTIALS_FILE = '.credentials.json'

/** One-shot `test -e` probe inside a WSL distro; mirrors the manager's fs budget. */
const DETECT_PROBE_TIMEOUT_MS = 10_000

export interface ClaudeAccountProfileAdapterDeps {
  /**
   * WSL-on-Windows only: the profile home lives inside the distro filesystem,
   * which node:fs cannot stat, so existence is probed with an argv-array
   * `test -e` through the runtime (the same mechanism the
   * AccountProfileManager uses for profile-home fs operations). Without a
   * runner the probe conservatively reports `unknown` — never a guessed
   * `ready` / `login-required`.
   */
  readonly commands?: CommandRunner
  /** Runtime resolution seam for tests; defaults to createWorkspaceRuntime. */
  readonly createRuntime?: (ref: WorkspaceRuntimeRef) => IpcResult<WorkspaceRuntime>
  /**
   * Host-native credentials-existence seam for tests. Receives the profile's
   * configHome VERBATIM and owns the credentials-file join itself (the host
   * path module only matches the runtime when the runtime is host-native,
   * which is exactly the branch this seam serves); defaults to node:fs.
   */
  readonly fs?: { credentialsExist(configHome: string): boolean }
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

export function createClaudeAccountProfileAdapter(
  deps: ClaudeAccountProfileAdapterDeps = {},
): AgentAccountProfileAdapter {
  const createRuntime =
    deps.createRuntime ?? ((ref: WorkspaceRuntimeRef) => createWorkspaceRuntime(ref))
  const fs = deps.fs ?? {
    credentialsExist: (configHome: string) => existsSync(join(configHome, CLAUDE_CREDENTIALS_FILE)),
  }

  const detectCredentials = async (
    profile: AgentAccountProfile,
    configHome: string,
  ): Promise<IpcResult<AccountProfileStatusDetection>> => {
    const runtimeResult = createRuntime(profile.runtime)
    if (!runtimeResult.ok) {
      // Cannot even describe the runtime — the probe is inconclusive.
      return ok({ status: 'unknown' })
    }
    const runtime = runtimeResult.data

    if (runtime.hostNative) {
      // Host-native runtime: node:fs IS the runtime's filesystem.
      let present: boolean
      try {
        present = fs.credentialsExist(configHome)
      } catch {
        return ok({ status: 'unknown' })
      }
      return ok({ status: present ? 'ready' : 'login-required' })
    }

    // WSL-on-Windows: probe inside the distro with a runtime-native path.
    if (deps.commands === undefined) {
      return ok({ status: 'unknown' })
    }
    const probe = await deps.commands.run({
      command: 'test',
      args: ['-e', posix.join(configHome, CLAUDE_CREDENTIALS_FILE)],
      runtime,
      timeoutMs: DETECT_PROBE_TIMEOUT_MS,
    })
    if (!probe.ok) {
      return ok({ status: 'unknown' })
    }
    if (probe.data.exitCode === 0) {
      return ok({ status: 'ready' })
    }
    if (probe.data.exitCode === 1) {
      return ok({ status: 'login-required' })
    }
    return ok({ status: 'unknown' })
  }

  return {
    agentId: CLAUDE_AGENT.id,
    reservedEnvKeys: [CLAUDE_CONFIG_DIR_ENV],

    buildRuntimeProjection(profile) {
      if (profile.configHome === undefined) {
        // §52 legacy fallback: a profile without a configHome (e.g. an
        // `external` profile) inherits the legacy CLI default environment —
        // the adapter is only invoked when there IS a profile, and it must
        // never invent a config dir for one that has none.
        return {
          ok: false,
          error: toPublicError({
            code: 'VALIDATION_FAILED',
            message: `Account profile "${profile.name}" has no config home to project.`,
            retryable: false,
            detail: `CLAUDE_CONFIG_DIR projection requires configHome; profile ${profile.id} has none`,
          }),
        }
      }
      // §5.3: verbatim, no resolveRuntimePath.
      return ok({ env: { [CLAUDE_CONFIG_DIR_ENV]: profile.configHome } })
    },

    async detectStatus(profile) {
      if (profile.configHome === undefined) {
        // Nothing profile-scoped to probe; the legacy environment's auth
        // state is out of scope for this adapter.
        return ok({ status: 'unknown' })
      }
      return detectCredentials(profile, profile.configHome)
    },

    buildLoginCommand() {
      // Claude Code has no repo-confirmed non-interactive login subcommand:
      // the definition declares only `claude` (interactiveArgs []) and login
      // is the in-TUI flow — a FRESH CLAUDE_CONFIG_DIR makes the CLI run its
      // official first-run onboarding (choose account / sign in), and an
      // expired profile completes `/login` in the same interactive session.
      // §24's Login Terminal is interactive by design, so launching the CLI
      // bare is the version-independent invocation; argv array, never a
      // shell string. The profile env comes from buildRuntimeProjection.
      return ok({ command: CLAUDE_AGENT.executable.command, args: [] })
    },
  }
}
