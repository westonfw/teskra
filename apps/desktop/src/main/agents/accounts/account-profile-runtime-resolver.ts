import type { AgentAccountProfile, IpcResult, WorkspaceRuntimeRef } from '@teskra/contracts'

import type { AccountProfileRepository } from '../../db/repositories'
import { toPublicError } from '../../errors'

/**
 * AccountProfileRuntimeResolver (TASK-097) — the §37 Profile Selector.
 *
 * First-phase rule order:
 *
 *   0. Filter candidates by runtime compatibility (same kind; wsl also
 *      requires the same distro — managed WSL profiles always pin one).
 *   1. Explicit accountProfileId from the Run request.
 *   2. (ExecutionProfile.accountProfileId — no ExecutionProfiles yet.)
 *   3. The runtime-compatible Agent default account.
 *   4. None → undefined = legacy CLI default environment (§37.1 / §52).
 *
 * Hard rules:
 * - An explicit but runtime-incompatible or disabled profile is an ERROR,
 *   never a silent downgrade (§37).
 * - A default pointing at a disabled profile is an ERROR prompting the user
 *   to reset the default — it does NOT fall back to legacy (§47.2 (2)).
 * - A runtime-incompatible DEFAULT is filtered out (step 0) and falls
 *   through to legacy fallback — that is the designed behavior for "the
 *   default happens to be for another runtime".
 * - "Exactly one ready profile exists" is NOT a selection rule (§37.1).
 */

/** Distro names compare case-insensitively (stored lowercase, migration 012). */
export function isRuntimeCompatible(
  profile: AgentAccountProfile,
  runtime: WorkspaceRuntimeRef,
): boolean {
  if (profile.runtime.kind !== runtime.kind) {
    return false
  }
  if (profile.runtime.kind !== 'wsl') {
    return true
  }
  return (profile.runtime.distro ?? '').toLowerCase() === (runtime.distro ?? '').toLowerCase()
}

/** Where the default account profile id lives (Settings — see the Manager). */
export interface AccountProfileDefaults {
  getDefault(agentId: string): Promise<IpcResult<string | undefined>>
}

export interface AccountProfileRuntimeResolver {
  resolve(
    agentId: string,
    workspaceRuntime: WorkspaceRuntimeRef,
    explicitProfileId?: string,
  ): Promise<IpcResult<AgentAccountProfile | undefined>>
}

export interface AccountProfileRuntimeResolverDeps {
  readonly profiles: AccountProfileRepository
  readonly defaults: AccountProfileDefaults
}

function fail(
  code: 'VALIDATION_FAILED' | 'CONFLICT',
  message: string,
  detail: string,
): IpcResult<never> {
  return { ok: false, error: toPublicError({ code, message, retryable: false, detail }) }
}

export function createAccountProfileRuntimeResolver(
  deps: AccountProfileRuntimeResolverDeps,
): AccountProfileRuntimeResolver {
  return {
    async resolve(agentId, workspaceRuntime, explicitProfileId) {
      if (explicitProfileId !== undefined) {
        const found = deps.profiles.getById(explicitProfileId)
        if (!found.ok) {
          return found
        }
        const profile = found.data
        if (profile === null || profile.agentId !== agentId) {
          return fail(
            'VALIDATION_FAILED',
            'The selected account profile does not exist for this agent.',
            `explicitProfileId=${explicitProfileId} agentId=${agentId}`,
          )
        }
        if (!profile.enabled) {
          return fail(
            'CONFLICT',
            `Account profile "${profile.name}" is disabled. Enable it or choose another profile.`,
            `explicit profile ${profile.id} is disabled`,
          )
        }
        if (!isRuntimeCompatible(profile, workspaceRuntime)) {
          return fail(
            'VALIDATION_FAILED',
            `Account profile "${profile.name}" belongs to a different runtime and cannot run in this workspace.`,
            `explicit profile ${profile.id} runtime=${JSON.stringify(profile.runtime)} workspace=${JSON.stringify(workspaceRuntime)}`,
          )
        }
        return { ok: true, data: profile }
      }

      const defaultId = await deps.defaults.getDefault(agentId)
      if (!defaultId.ok) {
        return defaultId
      }
      if (defaultId.data === undefined) {
        // §37.1: never guess from candidate count — legacy CLI environment.
        return { ok: true, data: undefined }
      }

      const found = deps.profiles.getById(defaultId.data)
      if (!found.ok) {
        return found
      }
      const profile = found.data
      if (profile === null) {
        return fail(
          'CONFLICT',
          'The default account profile no longer exists. Set a new default in Settings.',
          `default profile ${defaultId.data} missing for agent ${agentId}`,
        )
      }
      if (!profile.enabled) {
        // §47.2 (2): deterministic error, no legacy fallback.
        return fail(
          'CONFLICT',
          `The default account profile "${profile.name}" is disabled. Set a new default in Settings.`,
          `default profile ${profile.id} is disabled`,
        )
      }
      if (!isRuntimeCompatible(profile, workspaceRuntime)) {
        // §37 step 0: an incompatible default is filtered out, falling
        // through to the legacy CLI environment.
        return { ok: true, data: undefined }
      }
      return { ok: true, data: profile }
    },
  }
}
