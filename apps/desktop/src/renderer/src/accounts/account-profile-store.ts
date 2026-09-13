import type {
  AccountProfileIdRequest,
  AgentAccountProfile,
  CreateAccountProfileRequest,
  IpcResult,
  PublicAppError,
  RemoveAccountProfileRequest,
  SetDefaultAccountProfileRequest,
  UpdateAccountProfileRequest,
  WorkbenchEvents,
} from '@teskra/contracts'
import { create } from 'zustand'
import { transportError } from '../i18n'

export interface AccountProfileStoreBridge {
  readonly account: {
    list(request?: { agentId?: string }): Promise<IpcResult<AgentAccountProfile[]>>
    get(request: AccountProfileIdRequest): Promise<IpcResult<AgentAccountProfile | null>>
    create(request: CreateAccountProfileRequest): Promise<IpcResult<AgentAccountProfile>>
    update(request: UpdateAccountProfileRequest): Promise<IpcResult<AgentAccountProfile>>
    remove(request: RemoveAccountProfileRequest): Promise<IpcResult<AgentAccountProfile>>
    disable(request: AccountProfileIdRequest): Promise<IpcResult<AgentAccountProfile>>
    enable(request: AccountProfileIdRequest): Promise<IpcResult<AgentAccountProfile>>
    detect(request: AccountProfileIdRequest): Promise<IpcResult<AgentAccountProfile>>
    setDefault(request: SetDefaultAccountProfileRequest): Promise<IpcResult<void>>
  }
  readonly events: {
    subscribe<
      Name extends
        | 'account.created'
        | 'account.updated'
        | 'account.status_changed'
        | 'account.login_required'
        | 'account.limited',
    >(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}

interface AccountProfileState {
  readonly profiles: readonly AgentAccountProfile[]
  readonly loading: boolean
  readonly error?: PublicAppError | undefined
  startSynchronization(): () => void
  refresh(): Promise<void>
  createProfile(request: CreateAccountProfileRequest): Promise<AgentAccountProfile | undefined>
  updateProfile(request: UpdateAccountProfileRequest): Promise<AgentAccountProfile | undefined>
  removeProfile(id: string, deleteHome?: boolean): Promise<AgentAccountProfile | undefined>
  disableProfile(id: string): Promise<AgentAccountProfile | undefined>
  enableProfile(id: string): Promise<AgentAccountProfile | undefined>
  detectProfile(id: string): Promise<AgentAccountProfile | undefined>
  setDefaultProfile(agentId: string, profileId: string | null): Promise<boolean>
  clearError(): void
}

function upsertProfile(
  profiles: readonly AgentAccountProfile[],
  profile: AgentAccountProfile,
): AgentAccountProfile[] {
  const rest = profiles.filter(({ id }) => id !== profile.id)
  return [profile, ...rest].sort(
    (left, right) =>
      left.agentId.localeCompare(right.agentId) || left.createdAt.localeCompare(right.createdAt),
  )
}

export function createAccountProfileStore(getBridge: () => AccountProfileStoreBridge) {
  let synchronizationUsers = 0
  let stopSynchronization: (() => void) | undefined
  let refreshGeneration = 0

  return create<AccountProfileState>((set) => {
    /** Runs a mutation, upserts the returned profile, reports failures. */
    const mutate = async (
      operation: () => Promise<IpcResult<AgentAccountProfile>>,
    ): Promise<AgentAccountProfile | undefined> => {
      set({ error: undefined })
      try {
        const result = await operation()
        if (!result.ok) {
          set({ error: result.error })
          return undefined
        }
        set((state) => ({ profiles: upsertProfile(state.profiles, result.data) }))
        return result.data
      } catch {
        set({ error: transportError() })
        return undefined
      }
    }

    return {
      profiles: [],
      loading: false,

      startSynchronization() {
        synchronizationUsers += 1
        if (stopSynchronization === undefined) {
          const bridge = getBridge()
          // Every lifecycle event carries only ids — refetch the affected
          // profile so the list shows the authoritative row (§16 status is
          // recomputed in Main, e.g. after a login session exits).
          const refreshOne = ({ profileId }: { profileId: string }): void => {
            void bridge.account
              .get({ id: profileId })
              .then((result) => {
                if (!result.ok) set({ error: result.error })
                else if (result.data !== null) {
                  const profile = result.data
                  set((state) => ({ profiles: upsertProfile(state.profiles, profile) }))
                }
              })
              .catch(() => set({ error: transportError() }))
          }
          const stops = [
            bridge.events.subscribe('account.created', refreshOne),
            bridge.events.subscribe('account.updated', refreshOne),
            bridge.events.subscribe('account.status_changed', refreshOne),
            bridge.events.subscribe('account.login_required', refreshOne),
            bridge.events.subscribe('account.limited', refreshOne),
          ]
          stopSynchronization = () => {
            for (const stop of stops) stop()
          }
        }

        let active = true
        return () => {
          if (!active) return
          active = false
          synchronizationUsers -= 1
          if (synchronizationUsers === 0) {
            stopSynchronization?.()
            stopSynchronization = undefined
          }
        }
      },

      async refresh() {
        const generation = ++refreshGeneration
        set({ loading: true, error: undefined })
        try {
          // §18.0: opening the page (one account.list) is also the lazy
          // limited-sweep trigger — Main demotes expired `limited` rows
          // before answering, so no separate sweep call exists.
          const result = await getBridge().account.list()
          if (generation !== refreshGeneration) return
          set(
            result.ok
              ? { profiles: sortProfiles(result.data), loading: false }
              : { error: result.error, loading: false },
          )
        } catch {
          if (generation === refreshGeneration) {
            set({ error: transportError(), loading: false })
          }
        }
      },

      async createProfile(request) {
        return mutate(() => getBridge().account.create(request))
      },

      async updateProfile(request) {
        return mutate(() => getBridge().account.update(request))
      },

      async removeProfile(id, deleteHome) {
        return mutate(() =>
          getBridge().account.remove({ id, ...(deleteHome === undefined ? {} : { deleteHome }) }),
        )
      },

      async disableProfile(id) {
        return mutate(() => getBridge().account.disable({ id }))
      },

      async enableProfile(id) {
        return mutate(() => getBridge().account.enable({ id }))
      },

      async detectProfile(id) {
        return mutate(() => getBridge().account.detect({ id }))
      },

      async setDefaultProfile(agentId, profileId) {
        set({ error: undefined })
        try {
          const result = await getBridge().account.setDefault({ agentId, profileId })
          if (!result.ok) {
            set({ error: result.error })
            return false
          }
          return true
        } catch {
          set({ error: transportError() })
          return false
        }
      },

      clearError() {
        set({ error: undefined })
      },
    }
  })
}

function sortProfiles(profiles: readonly AgentAccountProfile[]): AgentAccountProfile[] {
  return [...profiles].sort(
    (left, right) =>
      left.agentId.localeCompare(right.agentId) || left.createdAt.localeCompare(right.createdAt),
  )
}

export const useAccountProfileStore = createAccountProfileStore(() => window.teskra)
