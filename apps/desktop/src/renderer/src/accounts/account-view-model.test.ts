import type { AgentAccountProfile, ResolvedConfig } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { enUS, type TranslationKey } from '../i18n/en-US'
import { accountLoginTransport, type AccountLoginBridge } from './account-login-transport'
import {
  accountLastUsedLabel,
  accountRuntimeLabel,
  accountStatusTag,
  defaultAccountProfileId,
  isValidAccountSlug,
  isValidConfigHomePath,
  profilesByAgent,
  slugifyAccountName,
} from './account-view-model'

const translate = (key: TranslationKey, params?: Record<string, string | number>): string => {
  let text: string = enUS[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

const AT = '2026-09-10T00:00:00.000Z'

function makeProfile(overrides: Partial<AgentAccountProfile>): AgentAccountProfile {
  return {
    id: 'acct-1',
    agentId: 'codex',
    name: 'Personal',
    authType: 'subscription',
    runtime: { kind: 'windows' },
    status: 'ready',
    enabled: true,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  }
}

describe('accountStatusTag', () => {
  it('maps every status and the disabled presentation state (§16)', () => {
    expect(accountStatusTag(makeProfile({ status: 'ready' }), translate).color).toBe('green')
    expect(accountStatusTag(makeProfile({ status: 'login-required' }), translate).label).toBe(
      enUS['accounts.status.loginRequired'],
    )
    expect(accountStatusTag(makeProfile({ status: 'unknown' }), translate).color).toBe('default')
    const disabled = accountStatusTag(makeProfile({ status: 'ready', enabled: false }), translate)
    expect(disabled.label).toBe(enUS['accounts.status.disabled'])
  })

  it('shows the reset time for a limited profile', () => {
    const tag = accountStatusTag(
      makeProfile({ status: 'limited', limitedUntil: '2026-09-12T03:12:00.000Z' }),
      translate,
    )
    expect(tag.color).toBe('orange')
    expect(tag.label).toContain(new Date('2026-09-12T03:12:00.000Z').toLocaleString())
  })
})

describe('accountRuntimeLabel', () => {
  it('labels windows and wsl runtimes', () => {
    expect(accountRuntimeLabel({ kind: 'windows' })).toBe('Windows')
    expect(accountRuntimeLabel({ kind: 'wsl', distro: 'Ubuntu-22.04' })).toBe('WSL · Ubuntu-22.04')
  })
})

describe('accountLastUsedLabel', () => {
  const now = Date.parse('2026-09-12T12:00:00.000Z')

  it('handles never-used, recent, and older timestamps', () => {
    expect(accountLastUsedLabel(makeProfile({}), now, translate)).toBe(
      enUS['accounts.lastUsed.never'],
    )
    expect(
      accountLastUsedLabel(makeProfile({ lastUsedAt: '2026-09-12T11:48:00.000Z' }), now, translate),
    ).toBe('12 min ago')
    expect(
      accountLastUsedLabel(makeProfile({ lastUsedAt: '2026-09-11T12:00:00.000Z' }), now, translate),
    ).toBe('1 d ago')
  })
})

describe('defaultAccountProfileId', () => {
  it('reads config.agents.defaultAccountProfiles and treats null as unset', () => {
    const resolved = {
      config: { agents: { defaultAccountProfiles: { codex: 'acct-1', claude: null } } },
    } as unknown as ResolvedConfig
    expect(defaultAccountProfileId(resolved, 'codex')).toBe('acct-1')
    expect(defaultAccountProfileId(resolved, 'claude')).toBeUndefined()
    expect(defaultAccountProfileId(undefined, 'codex')).toBeUndefined()
  })
})

describe('slug helpers (§48.1)', () => {
  it('validates the slug pattern', () => {
    expect(isValidAccountSlug('personal')).toBe(true)
    expect(isValidAccountSlug('work-2')).toBe(true)
    expect(isValidAccountSlug('-bad')).toBe(false)
    expect(isValidAccountSlug('has space')).toBe(false)
    expect(isValidAccountSlug('')).toBe(false)
  })

  it('derives slugs from display names', () => {
    expect(slugifyAccountName('Personal')).toBe('personal')
    expect(slugifyAccountName('Work Account 2')).toBe('work-account-2')
    expect(slugifyAccountName('  --Weird__Name-- ')).toBe('weird-name')
  })
})

describe('profilesByAgent', () => {
  it('groups profiles under their agentId', () => {
    const groups = profilesByAgent([
      makeProfile({ id: 'a', agentId: 'codex' }),
      makeProfile({ id: 'b', agentId: 'claude' }),
      makeProfile({ id: 'c', agentId: 'codex' }),
    ])
    expect(groups.get('codex')?.map(({ id }) => id)).toEqual(['a', 'c'])
    expect(groups.get('claude')).toHaveLength(1)
  })
})

describe('accountLoginTransport', () => {
  function setup() {
    const handlers = new Map<string, Set<(payload: { sessionId: string; data?: string }) => void>>()
    const bridge: AccountLoginBridge = {
      account: {
        startLogin: vi.fn(async () => ({
          ok: true as const,
          data: { sessionId: 'session-1', profileId: 'acct-1', startedAt: AT },
        })),
        writeLogin: vi.fn(async () => ({ ok: true as const, data: undefined })),
        resizeLogin: vi.fn(async () => ({ ok: true as const, data: undefined })),
        cancelLogin: vi.fn(async () => ({ ok: true as const, data: undefined })),
      },
      events: {
        subscribe: (name, handler) => {
          const registered = handlers.get(name) ?? new Set()
          registered.add(handler as (payload: { sessionId: string }) => void)
          handlers.set(name, registered)
          return () => registered.delete(handler as (payload: { sessionId: string }) => void)
        },
      },
    }
    const emit = (name: string, payload: { sessionId: string; data?: string }): void => {
      for (const handler of handlers.get(name) ?? []) handler(payload)
    }
    return { bridge, emit }
  }

  it('forwards writes and resizes to the login channels', async () => {
    const { bridge } = setup()
    const transport = accountLoginTransport('session-1', bridge)
    await transport.write('session-1', 'yes\r')
    await transport.resize('session-1', 120, 40)
    expect(bridge.account.writeLogin).toHaveBeenCalledWith({
      sessionId: 'session-1',
      data: 'yes\r',
    })
    expect(bridge.account.resizeLogin).toHaveBeenCalledWith({
      sessionId: 'session-1',
      cols: 120,
      rows: 40,
    })
  })

  it('only relays output and exit events for its own session', () => {
    const { bridge, emit } = setup()
    const transport = accountLoginTransport('session-1', bridge)
    const output: string[] = []
    let closed = 0
    const stopOutput = transport.subscribeOutput('session-1', (data) => output.push(data))
    transport.subscribeClosed('session-1', () => {
      closed += 1
    })
    emit('account.login.output', { sessionId: 'other', data: 'nope' })
    emit('account.login.output', { sessionId: 'session-1', data: 'hello' })
    emit('account.login.exited', { sessionId: 'other' })
    emit('account.login.exited', { sessionId: 'session-1' })
    expect(output).toEqual(['hello'])
    expect(closed).toBe(1)
    stopOutput()
    emit('account.login.output', { sessionId: 'session-1', data: 'late' })
    expect(output).toEqual(['hello'])
  })
})

describe('isValidConfigHomePath (§5.3)', () => {
  it('accepts absolute paths and rejects ~ / env vars / relatives', () => {
    expect(isValidConfigHomePath(String.raw`C:\Users\weston\.codex`)).toBe(true)
    expect(isValidConfigHomePath('C:/Users/weston/.codex')).toBe(true)
    expect(isValidConfigHomePath('/home/weston/.codex')).toBe(true)
    expect(isValidConfigHomePath(String.raw`\\server\share\.codex`)).toBe(true)
    expect(isValidConfigHomePath('~/.codex')).toBe(false)
    expect(isValidConfigHomePath('$HOME/.codex')).toBe(false)
    expect(isValidConfigHomePath(String.raw`%USERPROFILE%\.codex`)).toBe(false)
    expect(isValidConfigHomePath('.codex')).toBe(false)
    expect(isValidConfigHomePath('')).toBe(false)
  })
})
