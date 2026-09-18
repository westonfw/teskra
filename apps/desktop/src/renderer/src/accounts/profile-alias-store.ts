import type {
  AgentAccountProfile,
  AgentExecutionProfile,
  BindProfileAliasRequest,
  IpcResult,
  ListProfileAliasesRequest,
  ProfileAlias,
  PublicAppError,
  UnbindProfileAliasRequest,
} from '@teskra/contracts'
import { create } from 'zustand'
import { transportError } from '../i18n'

/**
 * TASK-111 (§22/§28/§53.1) — Settings → Accounts → Aliases backing store.
 *
 * Holds the alias bindings plus the per-agent Profile lists the bind form
 * picks from (account profiles for kind=account, execution profiles for
 * kind=execution). Bind/unbind validation happens Main-side; the store just
 * surfaces the public error.
 */
export interface ProfileAliasStoreBridge {
  readonly account: {
    list(request?: { agentId?: string }): Promise<IpcResult<AgentAccountProfile[]>>
    listAliases(request?: ListProfileAliasesRequest): Promise<IpcResult<ProfileAlias[]>>
    bindAlias(request: BindProfileAliasRequest): Promise<IpcResult<ProfileAlias>>
    unbindAlias(request: UnbindProfileAliasRequest): Promise<IpcResult<boolean>>
  }
  readonly executionProfile: {
    list(request?: { agentId?: string }): Promise<IpcResult<AgentExecutionProfile[]>>
  }
}

interface ProfileAliasState {
  readonly aliases: readonly ProfileAlias[]
  readonly accountProfiles: readonly AgentAccountProfile[]
  readonly executionProfiles: readonly AgentExecutionProfile[]
  readonly loading: boolean
  readonly error?: PublicAppError | undefined
  refresh(): Promise<void>
  bindAlias(request: BindProfileAliasRequest): Promise<ProfileAlias | undefined>
  unbindAlias(request: UnbindProfileAliasRequest): Promise<boolean>
  clearError(): void
}

function sortAliases(aliases: readonly ProfileAlias[]): ProfileAlias[] {
  return [...aliases].sort(
    (left, right) =>
      left.agentId.localeCompare(right.agentId) ||
      left.kind.localeCompare(right.kind) ||
      left.alias.localeCompare(right.alias),
  )
}

export function createProfileAliasStore(getBridge: () => ProfileAliasStoreBridge) {
  return create<ProfileAliasState>((set) => ({
    aliases: [],
    accountProfiles: [],
    executionProfiles: [],
    loading: false,

    async refresh() {
      set({ loading: true, error: undefined })
      try {
        const bridge = getBridge()
        const [aliases, accounts, executions] = await Promise.all([
          bridge.account.listAliases(),
          bridge.account.list(),
          bridge.executionProfile.list(),
        ])
        if (!aliases.ok) {
          set({ error: aliases.error, loading: false })
          return
        }
        set({
          aliases: sortAliases(aliases.data),
          accountProfiles: accounts.ok ? accounts.data : [],
          executionProfiles: executions.ok ? executions.data : [],
          loading: false,
          ...(accounts.ok ? {} : { error: accounts.error }),
          ...(accounts.ok && !executions.ok ? { error: executions.error } : {}),
        })
      } catch {
        set({ error: transportError(), loading: false })
      }
    },

    async bindAlias(request) {
      set({ error: undefined })
      try {
        const result = await getBridge().account.bindAlias(request)
        if (!result.ok) {
          set({ error: result.error })
          return undefined
        }
        set((state) => ({
          aliases: sortAliases([
            result.data,
            ...state.aliases.filter(
              (alias) =>
                !(
                  alias.agentId === result.data.agentId &&
                  alias.kind === result.data.kind &&
                  alias.alias === result.data.alias
                ),
            ),
          ]),
        }))
        return result.data
      } catch {
        set({ error: transportError() })
        return undefined
      }
    },

    async unbindAlias(request) {
      set({ error: undefined })
      try {
        const result = await getBridge().account.unbindAlias(request)
        if (!result.ok) {
          set({ error: result.error })
          return false
        }
        if (result.data) {
          set((state) => ({
            aliases: state.aliases.filter(
              (alias) =>
                !(
                  alias.agentId === request.agentId &&
                  alias.kind === request.kind &&
                  alias.alias === request.alias
                ),
            ),
          }))
        }
        return result.data
      } catch {
        set({ error: transportError() })
        return false
      }
    },

    clearError() {
      set({ error: undefined })
    },
  }))
}

export const useProfileAliasStore = createProfileAliasStore(() => window.teskra)
