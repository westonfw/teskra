import type { AgentAccountProfile, PublicAppError } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createAccountProfileStore, type AccountProfileStoreBridge } from './account-profile-store'

const AT = '2026-09-10T00:00:00.000Z'

function makeProfile(
  overrides: Partial<AgentAccountProfile> & Pick<AgentAccountProfile, 'id'>,
): AgentAccountProfile {
  return {
    agentId: 'codex',
    name: 'Personal',
    authType: 'subscription',
    runtime: { kind: 'windows' },
    configHome: 'C:\\Users\\weston\\.teskra\\agent-profiles\\codex\\personal',
    status: 'ready',
    enabled: true,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  }
}

function setup(initial: AgentAccountProfile[] = [], listError?: PublicAppError) {
  const profiles = [...initial]
  const handlers = new Map<string, Set<(payload: { profileId: string }) => void>>()
  const bridge: AccountProfileStoreBridge = {
    account: {
      list: vi.fn(async () =>
        listError !== undefined
          ? { ok: false as const, error: listError }
          : { ok: true as const, data: [...profiles] },
      ),
      get: vi.fn(async ({ id }: { id: string }) => ({
        ok: true as const,
        data: profiles.find((profile) => profile.id === id) ?? null,
      })),
      create: vi.fn(async () => {
        const profile = makeProfile({ id: `acct-${profiles.length + 1}` })
        profiles.push(profile)
        return { ok: true as const, data: profile }
      }),
      update: vi.fn(async ({ id }: { id: string }) => {
        const profile = profiles.find((candidate) => candidate.id === id) as AgentAccountProfile
        return { ok: true as const, data: profile }
      }),
      remove: vi.fn(async ({ id }: { id: string }) => {
        const index = profiles.findIndex((candidate) => candidate.id === id)
        profiles[index] = { ...profiles[index], enabled: false } as AgentAccountProfile
        return { ok: true as const, data: profiles[index] }
      }),
      disable: vi.fn(async ({ id }: { id: string }) => {
        const index = profiles.findIndex((candidate) => candidate.id === id)
        profiles[index] = { ...profiles[index], enabled: false } as AgentAccountProfile
        return { ok: true as const, data: profiles[index] }
      }),
      enable: vi.fn(async ({ id }: { id: string }) => {
        const index = profiles.findIndex((candidate) => candidate.id === id)
        profiles[index] = { ...profiles[index], enabled: true } as AgentAccountProfile
        return { ok: true as const, data: profiles[index] }
      }),
      detect: vi.fn(async ({ id }: { id: string }) => {
        const index = profiles.findIndex((candidate) => candidate.id === id)
        profiles[index] = { ...profiles[index], status: 'ready' } as AgentAccountProfile
        return { ok: true as const, data: profiles[index] }
      }),
      setDefault: vi.fn(async () => ({ ok: true as const, data: undefined })),
    },
    events: {
      subscribe: (name, handler) => {
        const registered = handlers.get(name) ?? new Set()
        registered.add(handler as (payload: { profileId: string }) => void)
        handlers.set(name, registered)
        return () => registered.delete(handler as (payload: { profileId: string }) => void)
      },
    },
  }
  const store = createAccountProfileStore(() => bridge)
  const emit = (name: string, profileId: string): void => {
    for (const handler of handlers.get(name) ?? []) handler({ profileId })
  }
  return { bridge, store, emit, profiles }
}

describe('account-profile-store', () => {
  it('loads profiles on refresh and sorts them by agent then creation time', async () => {
    const { store } = setup([
      makeProfile({ id: 'b', agentId: 'codex', createdAt: '2026-09-11T00:00:00.000Z' }),
      makeProfile({ id: 'a', agentId: 'claude', createdAt: AT }),
    ])
    await store.getState().refresh()
    expect(store.getState().profiles.map(({ id }) => id)).toEqual(['a', 'b'])
    expect(store.getState().loading).toBe(false)
  })

  it('surfaces list failures as a public error', async () => {
    const { store } = setup([], {
      code: 'UNKNOWN',
      message: 'database unavailable',
      retryable: true,
    })
    await store.getState().refresh()
    expect(store.getState().error?.code).toBe('UNKNOWN')
    expect(store.getState().profiles).toEqual([])
  })

  it('creates a profile and upserts it into the list', async () => {
    const { bridge, store } = setup()
    const created = await store.getState().createProfile({
      agentId: 'codex',
      name: 'Personal',
      authType: 'subscription',
      runtime: { kind: 'windows' },
      slug: 'personal',
    })
    expect(created?.id).toBe('acct-1')
    expect(bridge.account.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'personal', authType: 'subscription' }),
    )
    expect(store.getState().profiles).toHaveLength(1)
  })

  it('remove is a soft disable reflected in the store', async () => {
    const { bridge, store } = setup([makeProfile({ id: 'acct-1' })])
    const removed = await store.getState().removeProfile('acct-1', true)
    expect(removed?.enabled).toBe(false)
    expect(bridge.account.remove).toHaveBeenCalledWith({ id: 'acct-1', deleteHome: true })
    expect(store.getState().profiles[0]?.enabled).toBe(false)
  })

  it('disable/enable/detect upsert the returned profile', async () => {
    const { store } = setup([makeProfile({ id: 'acct-1', status: 'unknown' })])
    await store.getState().disableProfile('acct-1')
    expect(store.getState().profiles[0]?.enabled).toBe(false)
    await store.getState().enableProfile('acct-1')
    expect(store.getState().profiles[0]?.enabled).toBe(true)
    await store.getState().detectProfile('acct-1')
    expect(store.getState().profiles[0]?.status).toBe('ready')
  })

  it('setDefault forwards null to clear the default', async () => {
    const { bridge, store } = setup()
    expect(await store.getState().setDefaultProfile('codex', null)).toBe(true)
    expect(bridge.account.setDefault).toHaveBeenCalledWith({ agentId: 'codex', profileId: null })
  })

  it('synchronization refetches the affected profile on account events', async () => {
    const { bridge, store, emit } = setup([makeProfile({ id: 'acct-1' })])
    const stop = store.getState().startSynchronization()
    emit('account.status_changed', 'acct-1')
    await vi.waitFor(() => expect(bridge.account.get).toHaveBeenCalledWith({ id: 'acct-1' }))
    stop()
  })

  it('stops subscribing once the last consumer leaves', async () => {
    const { store, emit, bridge } = setup([makeProfile({ id: 'acct-1' })])
    const stopA = store.getState().startSynchronization()
    const stopB = store.getState().startSynchronization()
    stopA()
    emit('account.updated', 'acct-1')
    await vi.waitFor(() => expect(bridge.account.get).toHaveBeenCalled())
    stopB()
    const calls = vi.mocked(bridge.account.get).mock.calls.length
    emit('account.updated', 'acct-1')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(vi.mocked(bridge.account.get).mock.calls.length).toBe(calls)
  })
})
