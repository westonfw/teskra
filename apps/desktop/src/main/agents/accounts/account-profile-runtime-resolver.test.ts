import { describe, expect, it } from 'vitest'

import type { AgentAccountProfile, IpcResult } from '@teskra/contracts'

import type { AccountProfileRepository } from '../../db/repositories'
import {
  createAccountProfileRuntimeResolver,
  isRuntimeCompatible,
} from './account-profile-runtime-resolver'

const UBUNTU = { kind: 'wsl', distro: 'Ubuntu-22.04' } as const

function profile(overrides: Partial<AgentAccountProfile> = {}): AgentAccountProfile {
  return {
    id: 'acct-1',
    agentId: 'codex',
    name: 'Codex Work',
    authType: 'subscription',
    runtime: { kind: 'wsl', distro: 'ubuntu-22.04' },
    configHome: '/home/u/.teskra/agent-profiles/codex/work',
    status: 'ready',
    enabled: true,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  }
}

function resolverWith(profiles: readonly AgentAccountProfile[], defaultId: string | undefined) {
  const byId = new Map(profiles.map((entry) => [entry.id, entry]))
  const repo: Pick<AccountProfileRepository, 'getById'> = {
    getById: (id): IpcResult<AgentAccountProfile | null> => ({
      ok: true,
      data: byId.get(id) ?? null,
    }),
  }
  return createAccountProfileRuntimeResolver({
    profiles: repo as AccountProfileRepository,
    defaults: { getDefault: () => Promise.resolve({ ok: true, data: defaultId }) },
  })
}

describe('isRuntimeCompatible (§37 step 0)', () => {
  it('requires the same kind, and the same distro for wsl (case-insensitive)', () => {
    const wslProfile = profile()
    expect(isRuntimeCompatible(wslProfile, UBUNTU)).toBe(true)
    expect(isRuntimeCompatible(wslProfile, { kind: 'wsl', distro: 'UBUNTU-22.04' })).toBe(true)
    expect(isRuntimeCompatible(wslProfile, { kind: 'wsl', distro: 'Debian' })).toBe(false)
    expect(isRuntimeCompatible(wslProfile, { kind: 'windows' })).toBe(false)

    const windowsProfile = profile({ runtime: { kind: 'windows' } })
    expect(isRuntimeCompatible(windowsProfile, { kind: 'windows' })).toBe(true)
    expect(isRuntimeCompatible(windowsProfile, UBUNTU)).toBe(false)
  })
})

describe('AccountProfileRuntimeResolver (§37)', () => {
  it('returns undefined without explicit id or default — never guesses (§37.1)', async () => {
    const resolver = resolverWith([profile()], undefined)
    const resolved = await resolver.resolve('codex', UBUNTU)
    expect(resolved).toEqual({ ok: true, data: undefined })
  })

  it('resolves the explicit profile when compatible and enabled', async () => {
    const explicit = profile({ id: 'acct-explicit' })
    const resolver = resolverWith([explicit], undefined)
    const resolved = await resolver.resolve('codex', UBUNTU, 'acct-explicit')
    expect(resolved.ok && resolved.data?.id).toBe('acct-explicit')
  })

  it('errors when the explicit profile is disabled', async () => {
    const resolver = resolverWith([profile({ enabled: false })], undefined)
    const resolved = await resolver.resolve('codex', UBUNTU, 'acct-1')
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe('ACCOUNT_PROFILE_DISABLED')
  })

  it('errors when the explicit profile is runtime-incompatible', async () => {
    const resolver = resolverWith([profile()], undefined)
    const resolved = await resolver.resolve('codex', { kind: 'windows' }, 'acct-1')
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe('ACCOUNT_PROFILE_INCOMPATIBLE')
  })

  it('errors when the explicit profile belongs to another agent', async () => {
    const resolver = resolverWith([profile({ agentId: 'claude' })], undefined)
    const resolved = await resolver.resolve('codex', UBUNTU, 'acct-1')
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe('ACCOUNT_PROFILE_MISMATCH')
  })

  it('errors when the explicit profile does not exist', async () => {
    const resolver = resolverWith([], undefined)
    const resolved = await resolver.resolve('codex', UBUNTU, 'acct-gone')
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe('ACCOUNT_PROFILE_NOT_FOUND')
  })

  it('falls back to legacy when the default is for another runtime', async () => {
    const resolver = resolverWith([profile()], 'acct-1')
    const resolved = await resolver.resolve('codex', { kind: 'windows' })
    expect(resolved).toEqual({ ok: true, data: undefined })
  })

  it('errors on a disabled default — no legacy fallback (§47.2 (2))', async () => {
    const resolver = resolverWith([profile({ enabled: false })], 'acct-1')
    const resolved = await resolver.resolve('codex', UBUNTU)
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe('ACCOUNT_PROFILE_DISABLED')
    expect(resolved.error.message).toContain('default')
  })

  it('errors when the default points at a deleted profile', async () => {
    const resolver = resolverWith([], 'acct-gone')
    const resolved = await resolver.resolve('codex', UBUNTU)
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe('ACCOUNT_PROFILE_NOT_FOUND')
  })
})
