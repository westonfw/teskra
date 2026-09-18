import type { ProfileAlias, PublicAppError } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createProfileAliasStore, type ProfileAliasStoreBridge } from './profile-alias-store'

const AT = '2026-09-10T00:00:00.000Z'

function makeAlias(overrides: Partial<ProfileAlias> & Pick<ProfileAlias, 'alias'>): ProfileAlias {
  return {
    agentId: 'codex',
    kind: 'account',
    profileId: 'acct-1',
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  }
}

function setup(initial: ProfileAlias[] = [], listError?: PublicAppError) {
  const aliases = [...initial]
  const bridge: ProfileAliasStoreBridge = {
    account: {
      list: vi.fn(async () => ({ ok: true as const, data: [] })),
      listAliases: vi.fn(async () =>
        listError !== undefined
          ? { ok: false as const, error: listError }
          : { ok: true as const, data: [...aliases] },
      ),
      bindAlias: vi.fn(async (request) => {
        const alias = makeAlias({
          agentId: request.agentId,
          kind: request.kind,
          alias: request.alias,
          profileId: request.profileId,
        })
        const index = aliases.findIndex(
          (candidate) =>
            candidate.agentId === alias.agentId &&
            candidate.kind === alias.kind &&
            candidate.alias === alias.alias,
        )
        if (index >= 0) aliases[index] = alias
        else aliases.push(alias)
        return { ok: true as const, data: alias }
      }),
      unbindAlias: vi.fn(async (request) => {
        const index = aliases.findIndex(
          (candidate) =>
            candidate.agentId === request.agentId &&
            candidate.kind === request.kind &&
            candidate.alias === request.alias,
        )
        if (index < 0) return { ok: true as const, data: false }
        aliases.splice(index, 1)
        return { ok: true as const, data: true }
      }),
    },
    executionProfile: {
      list: vi.fn(async () => ({ ok: true as const, data: [] })),
    },
  }
  return { bridge, store: createProfileAliasStore(() => bridge) }
}

describe('profile-alias-store (TASK-111)', () => {
  it('loads aliases sorted by agent, kind, alias', async () => {
    const { store } = setup([
      makeAlias({ alias: 'work', agentId: 'codex', kind: 'account' }),
      makeAlias({ alias: 'high', agentId: 'codex', kind: 'execution', profileId: 'exec-1' }),
      makeAlias({ alias: 'work', agentId: 'claude', kind: 'account', profileId: 'acct-2' }),
    ])
    await store.getState().refresh()
    expect(
      store.getState().aliases.map((alias) => `${alias.agentId}/${alias.kind}/${alias.alias}`),
    ).toEqual(['claude/account/work', 'codex/account/work', 'codex/execution/high'])
    expect(store.getState().loading).toBe(false)
  })

  it('surfaces list failures as a public error', async () => {
    const { store } = setup([], { code: 'UNKNOWN', message: 'db down', retryable: true })
    await store.getState().refresh()
    expect(store.getState().error?.code).toBe('UNKNOWN')
    expect(store.getState().aliases).toEqual([])
  })

  it('binds a new alias and upserts on re-bind', async () => {
    const { bridge, store } = setup()
    const bound = await store.getState().bindAlias({
      agentId: 'codex',
      kind: 'account',
      alias: 'work',
      profileId: 'acct-1',
    })
    expect(bound?.profileId).toBe('acct-1')
    expect(bridge.account.bindAlias).toHaveBeenCalledWith({
      agentId: 'codex',
      kind: 'account',
      alias: 'work',
      profileId: 'acct-1',
    })
    expect(store.getState().aliases).toHaveLength(1)

    // Re-binding the same (agentId, kind, alias) replaces, never duplicates.
    await store.getState().bindAlias({
      agentId: 'codex',
      kind: 'account',
      alias: 'work',
      profileId: 'acct-9',
    })
    expect(store.getState().aliases).toHaveLength(1)
    expect(store.getState().aliases[0]?.profileId).toBe('acct-9')
  })

  it('reports bind validation failures (Main-side §28 checks)', async () => {
    const { bridge, store } = setup()
    vi.mocked(bridge.account.bindAlias).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'ACCOUNT_PROFILE_MISMATCH',
        message: 'Account profile belongs to another agent.',
        retryable: false,
      },
    })
    const bound = await store.getState().bindAlias({
      agentId: 'codex',
      kind: 'account',
      alias: 'work',
      profileId: 'acct-claude',
    })
    expect(bound).toBeUndefined()
    expect(store.getState().error?.code).toBe('ACCOUNT_PROFILE_MISMATCH')
    expect(store.getState().aliases).toHaveLength(0)
  })

  it('unbinds and removes the row locally', async () => {
    const { store } = setup([makeAlias({ alias: 'work' })])
    expect(
      await store.getState().unbindAlias({ agentId: 'codex', kind: 'account', alias: 'work' }),
    ).toBe(true)
    expect(store.getState().aliases).toHaveLength(0)
  })

  it('keeps the list when unbind finds nothing', async () => {
    const { store } = setup([makeAlias({ alias: 'work' })])
    await store.getState().refresh()
    expect(
      await store.getState().unbindAlias({ agentId: 'codex', kind: 'execution', alias: 'work' }),
    ).toBe(false)
    expect(store.getState().aliases).toHaveLength(1)
  })
})
