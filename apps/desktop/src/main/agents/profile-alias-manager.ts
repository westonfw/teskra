import type {
  BindProfileAliasRequest,
  IpcResult,
  ProfileAlias,
  ProfileAliasKind,
  UnbindProfileAliasRequest,
} from '@teskra/contracts'

import type {
  AccountProfileRepository,
  ExecutionProfileRepository,
  ProfileAliasListFilter,
  ProfileAliasRepository,
} from '../db/repositories'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import { assertNoReservedEnvKeys } from './accounts/reserved-env-keys'

/**
 * ProfileAliasManager (TASK-111, Milestone 24 §28/§53.1/§54/§55, ADR-0011).
 *
 * Owns everything around the `profile_aliases` table beyond row storage:
 *
 * - **bind validation (§28)**: `profileId` must exist in the table `kind`
 *   names (account → agent_account_profiles, execution →
 *   agent_execution_profiles) and `profile.agentId` must equal the request's
 *   agentId — otherwise a "codex alias pointing at a claude profile" would
 *   only surface when a workflow actually runs.
 * - **runtime resolution (§54)**: `resolveAgentNodeProfiles` turns the alias
 *   strings on a workflow agent node (`accountProfile` / `profile`) into the
 *   machine-local Profile ids AgentManager.start expects. Both ids are
 *   returned independently; the §54 account-dimension priority
 *   (node.accountProfile > execution profile's account > defaults) is then
 *   applied by AgentManager's existing §14 logic, which treats an explicit
 *   accountProfileId as an override of the execution profile's account.
 * - **§55 rejections, kept distinguishable**: an unbound alias fails with a
 *   bind prompt and NEVER falls back to a default account (fallback is the
 *   §37.1 account mix-up); an alias value that is actually a Profile id is
 *   rejected outright (repo workflows are not allowed to name machine-local
 *   ids); a binding whose Profile was deleted or disabled fails instead of
 *   silently selecting something else.
 * - **§13.2 third line of defense**: `env` declared on a workflow node is
 *   screened against the account adapters' reserved keys
 *   (CODEX_HOME / CLAUDE_CONFIG_DIR) before it ever reaches a launch.
 */

export interface ResolveAgentNodeProfilesInput {
  readonly agentId: string
  /** AgentWorkflowNode.accountProfile — an account alias (§53.1). */
  readonly accountProfileAlias?: string | undefined
  /** AgentWorkflowNode.profile — an execution alias (§53.1). */
  readonly executionProfileAlias?: string | undefined
  /** AgentWorkflowNode.env — screened against §13.2 reserved keys. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Human-readable origin for errors/logs, e.g. `workflow node "implement"`. */
  readonly source: string
}

export interface ResolvedNodeProfiles {
  readonly accountProfileId?: string | undefined
  readonly executionProfileId?: string | undefined
  readonly env?: Record<string, string> | undefined
}

export interface ProfileAliasManager {
  list(filter?: ProfileAliasListFilter): IpcResult<ProfileAlias[]>
  bind(request: BindProfileAliasRequest): IpcResult<ProfileAlias>
  /** Returns false when no such binding existed. */
  unbind(request: UnbindProfileAliasRequest): IpcResult<boolean>
  resolveAgentNodeProfiles(input: ResolveAgentNodeProfilesInput): IpcResult<ResolvedNodeProfiles>
}

export interface ProfileAliasManagerDeps {
  readonly aliases: ProfileAliasRepository
  readonly accountProfiles: Pick<AccountProfileRepository, 'getById'>
  readonly executionProfiles: Pick<ExecutionProfileRepository, 'getById'>
  /** Aggregated §13.2 reserved keys (AccountProfileManager.reservedEnvKeys). */
  readonly reservedEnvKeys?: (() => readonly string[]) | undefined
  readonly now?: (() => string) | undefined
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

export function createProfileAliasManager(deps: ProfileAliasManagerDeps): ProfileAliasManager {
  const now = deps.now ?? ((): string => new Date().toISOString())

  /** §28: the bind target must exist in the kind's table and share the agentId. */
  const validateBindTarget = (
    kind: ProfileAliasKind,
    agentId: string,
    profileId: string,
  ): IpcResult<void> => {
    if (kind === 'account') {
      const found = deps.accountProfiles.getById(profileId)
      if (!found.ok) return found
      if (found.data === null) {
        return fail({
          code: 'ACCOUNT_PROFILE_NOT_FOUND',
          message: 'The account profile to bind does not exist.',
          retryable: false,
          detail: `alias bind target ${profileId} missing from agent_account_profiles`,
        })
      }
      if (found.data.agentId !== agentId) {
        return fail({
          code: 'ACCOUNT_PROFILE_MISMATCH',
          message: `Account profile "${found.data.name}" belongs to agent "${found.data.agentId}", not "${agentId}".`,
          retryable: false,
          detail: `alias bind target ${profileId} agentId=${found.data.agentId} != ${agentId}`,
        })
      }
      return { ok: true, data: undefined }
    }
    const found = deps.executionProfiles.getById(profileId)
    if (!found.ok) return found
    if (found.data === null) {
      return fail({
        code: 'EXECUTION_PROFILE_NOT_FOUND',
        message: 'The execution profile to bind does not exist.',
        retryable: false,
        detail: `alias bind target ${profileId} missing from agent_execution_profiles`,
      })
    }
    if (found.data.agentId !== agentId) {
      return fail({
        code: 'EXECUTION_PROFILE_MISMATCH',
        message: `Execution profile "${found.data.name}" belongs to agent "${found.data.agentId}", not "${agentId}".`,
        retryable: false,
        detail: `alias bind target ${profileId} agentId=${found.data.agentId} != ${agentId}`,
      })
    }
    return { ok: true, data: undefined }
  }

  /** §55: true when the value names an existing Profile row in either table. */
  const matchesExistingProfileId = (value: string): IpcResult<boolean> => {
    const account = deps.accountProfiles.getById(value)
    if (!account.ok) return account
    if (account.data !== null) return { ok: true, data: true }
    const execution = deps.executionProfiles.getById(value)
    if (!execution.ok) return execution
    return { ok: true, data: execution.data !== null }
  }

  const resolveOne = (
    agentId: string,
    kind: ProfileAliasKind,
    alias: string,
    source: string,
  ): IpcResult<string> => {
    const bound = deps.aliases.resolve(agentId, kind, alias)
    if (!bound.ok) return bound
    if (bound.data === undefined) {
      // §55: a value that IS a local Profile id gets its own rejection — repo
      // workflows must go through the binding table, never name ids.
      const isId = matchesExistingProfileId(alias)
      if (!isId.ok) return isId
      if (isId.data) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `"${alias}" is a machine-local Profile id. Repo workflows must reference a profile alias instead — bind one in Settings → Accounts → Aliases.`,
          messageKey: 'errorMessage.profileAliasIdRejected',
          params: { value: alias, kind },
          retryable: false,
          detail: `${source}: ${kind} reference ${JSON.stringify(alias)} is a profile id, not an alias`,
        })
      }
      // §53.1: unbound alias — report and ask for a binding; NEVER fall back
      // to a default account (that is the §37.1 account mix-up).
      return fail({
        code: 'VALIDATION_FAILED',
        message: `Profile alias "${alias}" (${kind}) is not bound for agent "${agentId}". Bind it in Settings → Accounts → Aliases — the run will not fall back to a default account.`,
        messageKey: 'errorMessage.profileAliasUnbound',
        params: { alias, kind, agentId },
        retryable: false,
        detail: `${source}: unbound ${kind} alias ${JSON.stringify(alias)} for agent ${agentId}`,
      })
    }
    const profileId = bound.data
    // The binding table has no FK (ADR-0011): a deleted/disabled Profile
    // leaves a dangling binding, which must fail here rather than silently
    // running under another identity.
    if (kind === 'account') {
      const profile = deps.accountProfiles.getById(profileId)
      if (!profile.ok) return profile
      if (profile.data === null) {
        return fail({
          code: 'ACCOUNT_PROFILE_NOT_FOUND',
          message: `Alias "${alias}" is bound to an account profile that no longer exists. Re-bind it in Settings → Accounts → Aliases.`,
          messageKey: 'errorMessage.profileAliasTargetMissing',
          params: { alias, kind },
          retryable: false,
          detail: `${source}: account alias ${JSON.stringify(alias)} bound to deleted profile ${profileId}`,
        })
      }
      if (!profile.data.enabled) {
        return fail({
          code: 'ACCOUNT_PROFILE_DISABLED',
          message: `Alias "${alias}" points at the disabled account profile "${profile.data.name}". Enable it or re-bind the alias.`,
          messageKey: 'errorMessage.profileAliasTargetDisabled',
          params: { alias, name: profile.data.name },
          retryable: false,
          detail: `${source}: account alias ${JSON.stringify(alias)} bound to disabled profile ${profileId}`,
        })
      }
      return { ok: true, data: profileId }
    }
    const profile = deps.executionProfiles.getById(profileId)
    if (!profile.ok) return profile
    if (profile.data === null) {
      return fail({
        code: 'EXECUTION_PROFILE_NOT_FOUND',
        message: `Alias "${alias}" is bound to an execution profile that no longer exists. Re-bind it in Settings → Accounts → Aliases.`,
        messageKey: 'errorMessage.profileAliasTargetMissing',
        params: { alias, kind },
        retryable: false,
        detail: `${source}: execution alias ${JSON.stringify(alias)} bound to deleted profile ${profileId}`,
      })
    }
    return { ok: true, data: profileId }
  }

  return {
    list(filter = {}) {
      return deps.aliases.list(filter)
    },

    bind(request) {
      const valid = validateBindTarget(request.kind, request.agentId, request.profileId)
      if (!valid.ok) return valid
      return deps.aliases.bind(
        {
          agentId: request.agentId,
          kind: request.kind,
          alias: request.alias,
          profileId: request.profileId,
        },
        now(),
      )
    },

    unbind(request) {
      return deps.aliases.unbind(request.agentId, request.kind, request.alias)
    },

    resolveAgentNodeProfiles(input) {
      // §13.2 third line of defense: a workflow node must not set the env
      // keys an account profile owns — rejected AND logged (never silently
      // dropped), same contract as the AgentManager start path.
      const reserved = deps.reservedEnvKeys?.() ?? []
      const envCheck = assertNoReservedEnvKeys(input.env, `${input.source} env`, reserved)
      if (!envCheck.ok) {
        getLogger('agent').warn(
          { source: input.source, error: envCheck.error },
          'Reserved account-profile env key rejected.',
        )
        return envCheck
      }

      let accountProfileId: string | undefined
      if (input.accountProfileAlias !== undefined) {
        const resolved = resolveOne(
          input.agentId,
          'account',
          input.accountProfileAlias,
          input.source,
        )
        if (!resolved.ok) return resolved
        accountProfileId = resolved.data
      }
      let executionProfileId: string | undefined
      if (input.executionProfileAlias !== undefined) {
        const resolved = resolveOne(
          input.agentId,
          'execution',
          input.executionProfileAlias,
          input.source,
        )
        if (!resolved.ok) return resolved
        executionProfileId = resolved.data
      }
      return {
        ok: true,
        data: {
          ...(accountProfileId === undefined ? {} : { accountProfileId }),
          ...(executionProfileId === undefined ? {} : { executionProfileId }),
          ...(input.env === undefined ? {} : { env: { ...input.env } }),
        },
      }
    },
  }
}
