import { describe, expect, it } from 'vitest'

import {
  bindProfileAliasRequestSchema,
  listProfileAliasesRequestSchema,
  profileAliasSchema,
  unbindProfileAliasRequestSchema,
} from './profile-alias'

const NOW = '2026-09-12T00:00:00.000Z'

describe('profileAliasSchema (TASK-111)', () => {
  it('accepts both kinds and round-trips a binding row', () => {
    for (const kind of ['account', 'execution'] as const) {
      const parsed = profileAliasSchema.safeParse({
        agentId: 'codex',
        kind,
        alias: 'work',
        profileId: kind === 'account' ? 'acct_codex_work' : 'exec_codex_high',
        createdAt: NOW,
        updatedAt: NOW,
      })
      expect(parsed.success).toBe(true)
    }
  })

  it('rejects unknown kinds and empty aliases', () => {
    expect(
      profileAliasSchema.safeParse({
        agentId: 'codex',
        kind: 'tool',
        alias: 'work',
        profileId: 'acct_codex_work',
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(false)
    expect(
      profileAliasSchema.safeParse({
        agentId: 'codex',
        kind: 'account',
        alias: '',
        profileId: 'acct_codex_work',
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(false)
  })
})

describe('profile alias IPC request schemas (§28)', () => {
  it('list filters are optional', () => {
    expect(listProfileAliasesRequestSchema.safeParse({}).success).toBe(true)
    expect(
      listProfileAliasesRequestSchema.safeParse({ agentId: 'codex', kind: 'account' }).success,
    ).toBe(true)
  })

  it('bind requires agentId + kind + alias + profileId', () => {
    expect(
      bindProfileAliasRequestSchema.safeParse({
        agentId: 'codex',
        kind: 'account',
        alias: 'work',
        profileId: 'acct_codex_work',
      }).success,
    ).toBe(true)
    expect(
      bindProfileAliasRequestSchema.safeParse({ agentId: 'codex', alias: 'work' }).success,
    ).toBe(false)
  })

  it('unbind requires the full primary key', () => {
    expect(
      unbindProfileAliasRequestSchema.safeParse({
        agentId: 'codex',
        kind: 'execution',
        alias: 'high-work',
      }).success,
    ).toBe(true)
    expect(
      unbindProfileAliasRequestSchema.safeParse({ agentId: 'codex', alias: 'high-work' }).success,
    ).toBe(false)
  })
})
