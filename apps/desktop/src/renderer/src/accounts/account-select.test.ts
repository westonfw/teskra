import { describe, expect, it } from 'vitest'

import type { AgentAccountProfile } from '@teskra/contracts'

import { enUS, type TranslationKey, type TranslationParams } from '../i18n/en-US'
import { zhCN } from '../i18n/zh-CN'
import { accountAutoLabel, accountSelectCollapses } from './account-select'

const translate = (key: TranslationKey, params?: TranslationParams): string => {
  let text: string = enUS[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

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

describe('accountSelectCollapses (§25)', () => {
  it('collapses when the sole candidate is the default profile', () => {
    const profile = makeProfile({ id: 'acct-1' })
    expect(accountSelectCollapses([profile], 'acct-1')).toBe(true)
  })

  it('stays visible when the sole candidate is not the default', () => {
    const profile = makeProfile({ id: 'acct-1' })
    expect(accountSelectCollapses([profile], undefined)).toBe(false)
    expect(accountSelectCollapses([profile], 'acct-other')).toBe(false)
  })

  it('stays visible with multiple candidates', () => {
    const profiles = [makeProfile({ id: 'acct-1' }), makeProfile({ id: 'acct-2', name: 'Work' })]
    expect(accountSelectCollapses(profiles, 'acct-1')).toBe(false)
  })
})

describe('accountAutoLabel (§25/§50.1)', () => {
  it('names the default profile when one exists', () => {
    const profile = makeProfile({ id: 'acct-1', name: 'Work' })
    expect(accountAutoLabel('acct-1', profile, translate)).toBe('Auto · Work')
  })

  it('exposes the host CLI account when there is no default', () => {
    expect(accountAutoLabel(undefined, undefined, translate)).toBe('Host CLI account (no profile)')
  })

  it('falls back to the generic label when the default profile is not loaded', () => {
    expect(accountAutoLabel('acct-missing', undefined, translate)).toBe('Auto (default account)')
  })

  it('has both new keys translated in zh-CN', () => {
    expect(zhCN['accounts.select.autoDefault']).toContain('{name}')
    expect(zhCN['accounts.select.autoHost'].length).toBeGreaterThan(0)
  })
})
