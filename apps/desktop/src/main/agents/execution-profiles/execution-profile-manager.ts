import { randomUUID } from 'node:crypto'

import type { AgentExecutionProfile, ApprovalMode, IpcResult } from '@teskra/contracts'

import type { ConfigService } from '../../config/config-service'
import type {
  AccountProfileRepository,
  ExecutionProfileListFilter,
  ExecutionProfileRepository,
} from '../../db/repositories'
import { type InternalAppError, toPublicError } from '../../errors'
import type { AgentRegistry } from '../agent-registry'

/**
 * ExecutionProfileManager (TASK-110, Milestone 24 §6.1/§14/§15).
 *
 * Owns the execution profile lifecycle: CRUD, the per-agent default (stored
 * in the global config layer, same pattern as the account default), and the
 * resolve() the AgentManager runs at Run start. No SQL (the Repository does
 * that), no Electron, no Renderer knowledge.
 *
 * Cross-object rule (design §14, enforced on create AND update): an
 * execution profile may only reference an account profile of the SAME agent
 * — a "Codex High" profile launching under a Claude account would silently
 * authenticate the wrong CLI home.
 *
 * resolve() reports the dedicated EXECUTION_PROFILE_* error codes (mirroring
 * ACCOUNT_PROFILE_*) so a wrong execution profile id can never be mistaken
 * for a generic bad request.
 */

export interface CreateExecutionProfileRequest {
  readonly agentId: string
  readonly name: string
  readonly accountProfileId?: string | undefined
  readonly model?: string | undefined
  readonly reasoningEffort?: string | undefined
  readonly approvalMode?: ApprovalMode | undefined
}

/** `null` clears a field back to unset; `undefined` leaves it untouched. */
export interface UpdateExecutionProfileRequest {
  readonly name?: string | undefined
  readonly accountProfileId?: string | null | undefined
  readonly model?: string | null | undefined
  readonly reasoningEffort?: string | null | undefined
  readonly approvalMode?: ApprovalMode | null | undefined
}

export interface ExecutionProfileManager {
  list(filter?: ExecutionProfileListFilter): Promise<IpcResult<AgentExecutionProfile[]>>
  get(id: string): Promise<IpcResult<AgentExecutionProfile | null>>
  create(request: CreateExecutionProfileRequest): Promise<IpcResult<AgentExecutionProfile>>
  update(
    id: string,
    patch: UpdateExecutionProfileRequest,
  ): Promise<IpcResult<AgentExecutionProfile>>
  /** Hard delete; a removed default is cleared from the config layer. */
  remove(id: string): Promise<IpcResult<boolean>>
  /** §15: per-agent default; null clears it. */
  setDefault(agentId: string, profileId: string | null): Promise<IpcResult<void>>
  getDefault(agentId: string): Promise<IpcResult<string | undefined>>
  /**
   * Run-start resolution (§14): the profile must exist and belong to the
   * requesting agent. Only the §6.1 narrowed fields exist to resolve — there
   * are no permission/tool/skill/env profile IDs to chase.
   */
  resolve(profileId: string, agentId: string): Promise<IpcResult<AgentExecutionProfile>>
}

export interface ExecutionProfileManagerDeps {
  readonly profiles: ExecutionProfileRepository
  readonly accountProfiles: Pick<AccountProfileRepository, 'getById'>
  readonly registry: Pick<AgentRegistry, 'has'>
  readonly config: Pick<ConfigService, 'resolve' | 'updateGlobal'>
  readonly createId?: () => string
  readonly now?: () => string
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

export function createExecutionProfileManager(
  deps: ExecutionProfileManagerDeps,
): ExecutionProfileManager {
  const createId = deps.createId ?? ((): string => randomUUID())
  const now = deps.now ?? ((): string => new Date().toISOString())

  const notFound = (id: string): IpcResult<never> =>
    fail({
      code: 'EXECUTION_PROFILE_NOT_FOUND',
      message: 'The execution profile no longer exists.',
      retryable: false,
      detail: `execution profile ${id} not found`,
    })

  /** §14: the referenced account profile must exist and share the agentId. */
  const validateAccountReference = (accountProfileId: string, agentId: string): IpcResult<void> => {
    const found = deps.accountProfiles.getById(accountProfileId)
    if (!found.ok) {
      return found
    }
    if (found.data === null) {
      return fail({
        code: 'ACCOUNT_PROFILE_NOT_FOUND',
        message: 'The referenced account profile does not exist.',
        retryable: false,
        detail: `execution profile for agent ${agentId} references missing account profile ${accountProfileId}`,
      })
    }
    if (found.data.agentId !== agentId) {
      return fail({
        code: 'VALIDATION_FAILED',
        message: `Account profile "${found.data.name}" belongs to agent "${found.data.agentId}", not "${agentId}".`,
        retryable: false,
        detail: `account profile ${accountProfileId} agentId=${found.data.agentId} != execution profile agentId=${agentId}`,
      })
    }
    return { ok: true, data: undefined }
  }

  const manager: ExecutionProfileManager = {
    list(filter) {
      return Promise.resolve(deps.profiles.list(filter))
    },

    get(id) {
      return Promise.resolve(deps.profiles.getById(id))
    },

    create(request) {
      if (!deps.registry.has(request.agentId)) {
        return Promise.resolve(
          fail({
            code: 'VALIDATION_FAILED',
            message: `Agent "${request.agentId}" is not registered.`,
            retryable: false,
            detail: `unknown agentId=${request.agentId}`,
          }),
        )
      }
      if (request.accountProfileId !== undefined) {
        const valid = validateAccountReference(request.accountProfileId, request.agentId)
        if (!valid.ok) {
          return Promise.resolve(valid)
        }
      }
      return Promise.resolve(
        deps.profiles.create(
          {
            id: createId(),
            name: request.name,
            agentId: request.agentId,
            ...(request.accountProfileId === undefined
              ? {}
              : { accountProfileId: request.accountProfileId }),
            ...(request.model === undefined ? {} : { model: request.model }),
            ...(request.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: request.reasoningEffort }),
            ...(request.approvalMode === undefined ? {} : { approvalMode: request.approvalMode }),
          },
          now(),
        ),
      )
    },

    update(id, patch) {
      const found = deps.profiles.getById(id)
      if (!found.ok) {
        return Promise.resolve(found)
      }
      if (found.data === null) {
        return Promise.resolve(notFound(id))
      }
      if (patch.accountProfileId !== undefined && patch.accountProfileId !== null) {
        const valid = validateAccountReference(patch.accountProfileId, found.data.agentId)
        if (!valid.ok) {
          return Promise.resolve(valid)
        }
      }
      const updated = deps.profiles.update(id, patch, now())
      if (!updated.ok) {
        return Promise.resolve(updated)
      }
      if (updated.data === null) {
        return Promise.resolve(notFound(id))
      }
      return Promise.resolve({ ok: true, data: updated.data })
    },

    async remove(id) {
      const found = deps.profiles.getById(id)
      if (!found.ok) {
        return found
      }
      if (found.data === null) {
        return { ok: true, data: false }
      }
      // Never leave the default pointing at a removed profile (mirrors
      // §47.2 (1) for account profiles).
      const currentDefault = await manager.getDefault(found.data.agentId)
      if (!currentDefault.ok) {
        return currentDefault
      }
      if (currentDefault.data === id) {
        const cleared = await manager.setDefault(found.data.agentId, null)
        if (!cleared.ok) {
          return cleared
        }
      }
      return deps.profiles.delete(id)
    },

    setDefault(agentId, profileId) {
      if (!deps.registry.has(agentId)) {
        return Promise.resolve(
          fail({
            code: 'VALIDATION_FAILED',
            message: `Agent "${agentId}" is not registered.`,
            retryable: false,
            detail: `unknown agentId=${agentId}`,
          }),
        )
      }
      if (profileId !== null) {
        const found = deps.profiles.getById(profileId)
        if (!found.ok) {
          return Promise.resolve(found)
        }
        if (found.data === null || found.data.agentId !== agentId) {
          return Promise.resolve(
            fail({
              code: 'VALIDATION_FAILED',
              message: 'The default execution profile must exist and belong to the agent.',
              retryable: false,
              detail: `default ${profileId} invalid for agent ${agentId}`,
            }),
          )
        }
      }
      const updated = deps.config.updateGlobal({
        agents: { defaultExecutionProfiles: { [agentId]: profileId } },
      })
      return Promise.resolve(updated.ok ? { ok: true, data: undefined } : updated)
    },

    getDefault(agentId) {
      const resolved = deps.config.resolve()
      if (!resolved.ok) {
        return Promise.resolve(resolved)
      }
      const value = resolved.data.config.agents.defaultExecutionProfiles[agentId]
      return Promise.resolve({ ok: true, data: value ?? undefined })
    },

    resolve(profileId, agentId) {
      const found = deps.profiles.getById(profileId)
      if (!found.ok) {
        return Promise.resolve(found)
      }
      const profile = found.data
      if (profile === null) {
        return Promise.resolve(
          fail({
            code: 'EXECUTION_PROFILE_NOT_FOUND',
            message: 'The selected execution profile does not exist.',
            retryable: false,
            detail: `executionProfileId=${profileId} agentId=${agentId}`,
          }),
        )
      }
      if (profile.agentId !== agentId) {
        return Promise.resolve(
          fail({
            code: 'EXECUTION_PROFILE_MISMATCH',
            message: `Execution profile "${profile.name}" belongs to agent "${profile.agentId}", not "${agentId}".`,
            retryable: false,
            detail: `execution profile ${profile.id} agentId=${profile.agentId} requested agent=${agentId}`,
          }),
        )
      }
      return Promise.resolve({ ok: true, data: profile })
    },
  }

  return manager
}
