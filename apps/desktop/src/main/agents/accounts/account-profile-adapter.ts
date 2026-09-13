import type { AccountProfileStatus, AgentAccountProfile, IpcResult } from '@teskra/contracts'

import { toPublicError } from '../../errors'
import type { WorkspaceRuntime } from '../../workspace/runtime'

/**
 * Milestone 24 §10.4 — the pluggable per-Agent account profile adapter.
 *
 * The AccountProfileManager owns profile persistence, home-directory
 * lifecycle, and the ownership guard; an adapter contributes only the
 * Agent-specific knowledge: which env keys project the profile into a Run
 * (Codex: CODEX_HOME, Claude: CLAUDE_CONFIG_DIR), how to probe the profile's
 * auth/quota status, and which official command logs the profile in.
 *
 * This module defines only the interface and the registry — the Codex and
 * Claude adapters land in TASK-098 / TASK-099.
 */

/** §13: everything a Run needs to execute as this profile. */
export interface AccountProfileRuntimeProjection {
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly executable?: string
  readonly args?: readonly string[]
}

/** §24 Login Terminal: an official CLI login invocation (argv, never a shell string). */
export interface AccountProfileLoginCommand {
  readonly command: string
  readonly args: readonly string[]
}

export interface AccountProfileStatusDetection {
  readonly status: AccountProfileStatus
  readonly limitedUntil?: string
}

export interface AgentAccountProfileAdapter {
  /** AgentDefinition.id — free-form string, never a hardcoded enum. */
  readonly agentId: string
  /**
   * Env keys this adapter owns when projecting a profile (§13.2), e.g.
   * CODEX_HOME. User-supplied env may never set these — the reserved list
   * is what lets the Run-start path reject such overrides.
   */
  readonly reservedEnvKeys: readonly string[]
  /** Projects a profile into spawn env/cwd for a Run inside the given runtime. */
  buildRuntimeProjection(
    profile: AgentAccountProfile,
    runtime: WorkspaceRuntime,
  ): IpcResult<AccountProfileRuntimeProjection>
  /** Probes auth/quota availability with the profile's env applied (§17/§18). */
  detectStatus(profile: AgentAccountProfile): Promise<IpcResult<AccountProfileStatusDetection>>
  /** The official login command for a fresh or expired profile home (§24). */
  buildLoginCommand(profile: AgentAccountProfile): IpcResult<AccountProfileLoginCommand>
  /**
   * Optional post-create hook for agent-specific bootstrap of a fresh
   * profile home (§10.2). Must never copy auth material between homes
   * (§10.3). A failure aborts profile creation with compensation.
   */
  initializeProfileHome?(profile: AgentAccountProfile): Promise<IpcResult<void>>
}

export interface AccountProfileAdapterRegistry {
  register(adapter: AgentAccountProfileAdapter): IpcResult<AgentAccountProfileAdapter>
  get(agentId: string): AgentAccountProfileAdapter | undefined
  has(agentId: string): boolean
}

export function createAccountProfileAdapterRegistry(
  initial: readonly AgentAccountProfileAdapter[] = [],
): IpcResult<AccountProfileAdapterRegistry> {
  const adapters = new Map<string, AgentAccountProfileAdapter>()

  const registry: AccountProfileAdapterRegistry = {
    register(adapter) {
      const existing = adapters.get(adapter.agentId)
      if (existing !== undefined) {
        return {
          ok: false,
          error: toPublicError({
            code: 'VALIDATION_FAILED',
            message: `An account profile adapter for agent "${adapter.agentId}" is already registered.`,
            retryable: false,
            detail: `duplicate AgentAccountProfileAdapter agentId=${adapter.agentId}`,
          }),
        }
      }
      adapters.set(adapter.agentId, adapter)
      return { ok: true, data: adapter }
    },
    get: (agentId) => adapters.get(agentId),
    has: (agentId) => adapters.has(agentId),
  }

  for (const adapter of initial) {
    const registered = registry.register(adapter)
    if (!registered.ok) {
      return registered
    }
  }
  return { ok: true, data: registry }
}
