import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../db/migrations'
import {
  createAccountProfileRepository,
  createExecutionProfileRepository,
  createProfileAliasRepository,
} from '../db/repositories'
import { createProfileAliasManager, type ProfileAliasManager } from './profile-alias-manager'

let connection: Database.Database
let manager: ProfileAliasManager

const AT = '2026-09-14T08:00:00.000Z'
const RESERVED = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR']

function setup(reservedEnvKeys: readonly string[] = RESERVED) {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
  manager = createProfileAliasManager({
    aliases: createProfileAliasRepository(connection),
    accountProfiles: createAccountProfileRepository(connection),
    executionProfiles: createExecutionProfileRepository(connection),
    reservedEnvKeys: () => reservedEnvKeys,
    now: () => AT,
  })
}

afterEach(() => {
  connection.close()
})

function insertAccountProfile(id: string, agentId = 'codex', enabled = true): void {
  const created = createAccountProfileRepository(connection).create(
    {
      id,
      agentId,
      name: `Account ${id}`,
      authType: 'subscription',
      runtime: { kind: 'windows' },
      enabled,
    },
    AT,
  )
  if (!created.ok) throw new Error(created.error.message)
}

function insertExecutionProfile(id: string, agentId = 'codex', accountProfileId?: string): void {
  const created = createExecutionProfileRepository(connection).create(
    {
      id,
      name: `Execution ${id}`,
      agentId,
      ...(accountProfileId === undefined ? {} : { accountProfileId }),
    },
    AT,
  )
  if (!created.ok) throw new Error(created.error.message)
}

function bindAccount(alias: string, profileId: string, agentId = 'codex') {
  return manager.bind({ agentId, kind: 'account', alias, profileId })
}

describe('ProfileAliasManager.bind (TASK-111 §28)', () => {
  it('binds when the profile exists in the kind table and belongs to the agent', () => {
    setup()
    insertAccountProfile('acct-1')
    const bound = bindAccount('work', 'acct-1')
    expect(bound).toMatchObject({
      ok: true,
      data: { agentId: 'codex', kind: 'account', alias: 'work', profileId: 'acct-1' },
    })
  })

  it('rejects a profileId missing from the kind table', () => {
    setup()
    insertExecutionProfile('exec-1')
    // exec-1 exists in the EXECUTION table — it must not validate as an account target.
    const result = bindAccount('work', 'exec-1')
    expect(result).toMatchObject({ ok: false, error: { code: 'ACCOUNT_PROFILE_NOT_FOUND' } })
  })

  it('rejects a profile belonging to a different agent', () => {
    setup()
    insertAccountProfile('acct-claude', 'claude')
    const result = bindAccount('work', 'acct-claude')
    expect(result).toMatchObject({ ok: false, error: { code: 'ACCOUNT_PROFILE_MISMATCH' } })
  })

  it('validates execution bindings against the execution table', () => {
    setup()
    insertAccountProfile('acct-1')
    const wrongTable = manager.bind({
      agentId: 'codex',
      kind: 'execution',
      alias: 'high',
      profileId: 'acct-1',
    })
    expect(wrongTable).toMatchObject({ ok: false, error: { code: 'EXECUTION_PROFILE_NOT_FOUND' } })

    insertExecutionProfile('exec-claude', 'claude')
    const mismatch = manager.bind({
      agentId: 'codex',
      kind: 'execution',
      alias: 'high',
      profileId: 'exec-claude',
    })
    expect(mismatch).toMatchObject({ ok: false, error: { code: 'EXECUTION_PROFILE_MISMATCH' } })
  })

  it('unbind reports whether a binding existed', () => {
    setup()
    insertAccountProfile('acct-1')
    bindAccount('work', 'acct-1')
    expect(manager.unbind({ agentId: 'codex', kind: 'account', alias: 'work' })).toEqual({
      ok: true,
      data: true,
    })
    expect(manager.unbind({ agentId: 'codex', kind: 'account', alias: 'work' })).toEqual({
      ok: true,
      data: false,
    })
  })
})

describe('ProfileAliasManager.resolveAgentNodeProfiles (§53.1/§54/§55)', () => {
  it('resolves account and execution aliases independently (kind isolation)', () => {
    setup()
    insertAccountProfile('acct-1')
    insertExecutionProfile('exec-1', 'codex', 'acct-1')
    bindAccount('work', 'acct-1')
    // The SAME alias name under kind=execution is a different binding.
    manager.bind({ agentId: 'codex', kind: 'execution', alias: 'work', profileId: 'exec-1' })

    const resolved = manager.resolveAgentNodeProfiles({
      agentId: 'codex',
      accountProfileAlias: 'work',
      executionProfileAlias: 'work',
      source: 'workflow node "implement"',
    })
    expect(resolved).toEqual({
      ok: true,
      data: { accountProfileId: 'acct-1', executionProfileId: 'exec-1' },
    })
  })

  it('keeps aliases isolated per agentId', () => {
    setup()
    insertAccountProfile('acct-codex', 'codex')
    insertAccountProfile('acct-claude', 'claude')
    bindAccount('work', 'acct-codex', 'codex')
    bindAccount('work', 'acct-claude', 'claude')

    expect(
      manager.resolveAgentNodeProfiles({
        agentId: 'claude',
        accountProfileAlias: 'work',
        source: 'node',
      }),
    ).toEqual({ ok: true, data: { accountProfileId: 'acct-claude' } })
  })

  it('fails an unbound alias with a bind prompt and never falls back to a default', () => {
    setup()
    insertAccountProfile('acct-1')
    const resolved = manager.resolveAgentNodeProfiles({
      agentId: 'codex',
      accountProfileAlias: 'work',
      source: 'workflow node "implement"',
    })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe('VALIDATION_FAILED')
    expect(resolved.error.messageKey).toBe('errorMessage.profileAliasUnbound')
    expect(resolved.error.message).toContain('will not fall back to a default account')
  })

  it('rejects a value that is actually a Profile id (§55)', () => {
    setup()
    insertAccountProfile('acct-1')
    const resolved = manager.resolveAgentNodeProfiles({
      agentId: 'codex',
      accountProfileAlias: 'acct-1',
      source: 'workflow node "implement"',
    })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe('VALIDATION_FAILED')
    expect(resolved.error.messageKey).toBe('errorMessage.profileAliasIdRejected')
    expect(resolved.error.message).toContain('alias')
  })

  it('rejects profile ids for the execution field as well (§55)', () => {
    setup()
    insertExecutionProfile('exec-1')
    const resolved = manager.resolveAgentNodeProfiles({
      agentId: 'codex',
      executionProfileAlias: 'exec-1',
      source: 'node',
    })
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', messageKey: 'errorMessage.profileAliasIdRejected' },
    })
  })

  it('fails when the bound account profile was deleted (dangling binding)', () => {
    setup()
    insertAccountProfile('acct-1')
    bindAccount('work', 'acct-1')
    // Hard delete behind the Manager's back — the binding table has no FK.
    createAccountProfileRepository(connection).delete('acct-1')

    const resolved = manager.resolveAgentNodeProfiles({
      agentId: 'codex',
      accountProfileAlias: 'work',
      source: 'node',
    })
    expect(resolved).toMatchObject({
      ok: false,
      error: {
        code: 'ACCOUNT_PROFILE_NOT_FOUND',
        messageKey: 'errorMessage.profileAliasTargetMissing',
      },
    })
  })

  it('fails when the bound account profile is disabled', () => {
    setup()
    insertAccountProfile('acct-1', 'codex', false)
    bindAccount('work', 'acct-1')

    const resolved = manager.resolveAgentNodeProfiles({
      agentId: 'codex',
      accountProfileAlias: 'work',
      source: 'node',
    })
    expect(resolved).toMatchObject({
      ok: false,
      error: {
        code: 'ACCOUNT_PROFILE_DISABLED',
        messageKey: 'errorMessage.profileAliasTargetDisabled',
      },
    })
  })

  it('fails when the bound execution profile was deleted', () => {
    setup()
    insertExecutionProfile('exec-1')
    manager.bind({ agentId: 'codex', kind: 'execution', alias: 'high', profileId: 'exec-1' })
    createExecutionProfileRepository(connection).delete('exec-1')

    const resolved = manager.resolveAgentNodeProfiles({
      agentId: 'codex',
      executionProfileAlias: 'high',
      source: 'node',
    })
    expect(resolved).toMatchObject({
      ok: false,
      error: {
        code: 'EXECUTION_PROFILE_NOT_FOUND',
        messageKey: 'errorMessage.profileAliasTargetMissing',
      },
    })
  })

  it('§54: both aliases resolve so node.accountProfile overrides the execution profile’s account downstream', () => {
    setup()
    insertAccountProfile('acct-explicit')
    insertAccountProfile('acct-from-exec')
    insertExecutionProfile('exec-1', 'codex', 'acct-from-exec')
    bindAccount('work', 'acct-explicit')
    manager.bind({ agentId: 'codex', kind: 'execution', alias: 'high', profileId: 'exec-1' })

    const resolved = manager.resolveAgentNodeProfiles({
      agentId: 'codex',
      accountProfileAlias: 'work',
      executionProfileAlias: 'high',
      source: 'node',
    })
    // Both ids are handed to AgentManager.start, whose §14 rule (explicit
    // accountProfileId > executionProfile.accountProfileId) IS the §54
    // account-dimension priority.
    expect(resolved).toEqual({
      ok: true,
      data: { accountProfileId: 'acct-explicit', executionProfileId: 'exec-1' },
    })
  })

  it('rejects reserved env keys on the node (§13.2 third line of defense)', () => {
    setup()
    const resolved = manager.resolveAgentNodeProfiles({
      agentId: 'codex',
      env: { CODEX_HOME: '/attacker/.codex', SAFE_VAR: 'ok' },
      source: 'workflow node "implement"',
    })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.error.code).toBe('VALIDATION_FAILED')
    expect(resolved.error.message).toContain('CODEX_HOME')
  })

  it('passes a clean node env through untouched', () => {
    setup()
    const resolved = manager.resolveAgentNodeProfiles({
      agentId: 'codex',
      env: { SAFE_VAR: 'ok' },
      source: 'node',
    })
    expect(resolved).toEqual({ ok: true, data: { env: { SAFE_VAR: 'ok' } } })
  })
})
