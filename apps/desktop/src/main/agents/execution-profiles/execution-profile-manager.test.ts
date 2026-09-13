import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import type { AgentAccountProfile, IpcResult } from '@teskra/contracts'

import { createConfigService } from '../../config/config-service'
import { migrateDatabase } from '../../db/migrations'
import {
  createAccountProfileRepository,
  createExecutionProfileRepository,
  type ExecutionProfileRepository,
} from '../../db/repositories'
import { createTeskraPaths } from '../../paths'
import { createDefaultAgentRegistry } from '../agent-registry'
import {
  createExecutionProfileManager,
  type ExecutionProfileManager,
} from './execution-profile-manager'

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

interface Fixture {
  readonly manager: ExecutionProfileManager
  readonly profiles: ExecutionProfileRepository
  readonly createAccount: (id: string, agentId?: string) => AgentAccountProfile
}

function setup(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-exec-profiles-'))
  directories.push(directory)
  const paths = createTeskraPaths({ TESKRA_HOME: join(directory, 'data') })

  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  databases.push(connection)

  const profiles = createExecutionProfileRepository(connection)
  const accountProfiles = createAccountProfileRepository(connection)
  const registry = createDefaultAgentRegistry(false)
  if (!registry.ok) throw new Error('expected Agent Registry')
  const config = createConfigService({ paths })

  let nextId = 1
  const manager = createExecutionProfileManager({
    profiles,
    accountProfiles,
    registry: registry.data,
    config,
    createId: () => `exec-${String(nextId++)}`,
    now: () => '2026-09-14T00:00:00.000Z',
  })

  const createAccount = (id: string, agentId = 'codex'): AgentAccountProfile =>
    requireOk(
      accountProfiles.create(
        {
          id,
          agentId,
          name: `Account ${id}`,
          authType: 'subscription',
          runtime: { kind: 'windows' },
        },
        '2026-09-14T00:00:00.000Z',
      ),
    )

  return { manager, profiles, createAccount }
}

describe('ExecutionProfileManager (TASK-110)', () => {
  it('creates, reads, updates, lists, and removes profiles', async () => {
    const fixture = setup()
    fixture.createAccount('acct-1')
    const created = requireOk(
      await fixture.manager.create({
        agentId: 'codex',
        name: 'Codex Personal High',
        accountProfileId: 'acct-1',
        model: 'gpt-5-codex',
        reasoningEffort: 'high',
        approvalMode: 'safe-auto',
      }),
    )
    expect(created).toMatchObject({
      id: 'exec-1',
      agentId: 'codex',
      accountProfileId: 'acct-1',
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
      approvalMode: 'safe-auto',
    })

    const updated = requireOk(
      await fixture.manager.update('exec-1', { name: 'Renamed', model: null }),
    )
    expect(updated.name).toBe('Renamed')
    expect(updated.model).toBeUndefined()
    expect(updated.reasoningEffort).toBe('high')

    expect(requireOk(await fixture.manager.list({ agentId: 'codex' })).map((p) => p.id)).toEqual([
      'exec-1',
    ])
    expect(requireOk(await fixture.manager.list({ agentId: 'claude' }))).toEqual([])

    expect(requireOk(await fixture.manager.remove('exec-1'))).toBe(true)
    expect(requireOk(await fixture.manager.get('exec-1'))).toBeNull()
    expect(requireOk(await fixture.manager.remove('exec-1'))).toBe(false)
  })

  it('rejects create / update for an unregistered agent', async () => {
    const fixture = setup()
    const created = await fixture.manager.create({ agentId: 'nope', name: 'P' })
    expect(created).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('rejects an accountProfileId whose profile belongs to another agent (create and update)', async () => {
    const fixture = setup()
    fixture.createAccount('acct-claude', 'claude')
    const created = await fixture.manager.create({
      agentId: 'codex',
      name: 'Cross Agent',
      accountProfileId: 'acct-claude',
    })
    expect(created).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })

    fixture.createAccount('acct-codex')
    requireOk(
      await fixture.manager.create({ agentId: 'codex', name: 'P', accountProfileId: 'acct-codex' }),
    )
    const updated = await fixture.manager.update('exec-1', { accountProfileId: 'acct-claude' })
    expect(updated).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    // Clearing the reference stays legal.
    expect(
      requireOk(await fixture.manager.update('exec-1', { accountProfileId: null }))
        .accountProfileId,
    ).toBeUndefined()
  })

  it('rejects a missing account profile reference', async () => {
    const fixture = setup()
    const created = await fixture.manager.create({
      agentId: 'codex',
      name: 'Dangling',
      accountProfileId: 'acct-missing',
    })
    expect(created).toMatchObject({ ok: false, error: { code: 'ACCOUNT_PROFILE_NOT_FOUND' } })
  })

  it('manages the per-agent default through the config layer', async () => {
    const fixture = setup()
    requireOk(await fixture.manager.create({ agentId: 'codex', name: 'P' }))
    expect(requireOk(await fixture.manager.getDefault('codex'))).toBeUndefined()

    expect(requireOk(await fixture.manager.setDefault('codex', 'exec-1'))).toBeUndefined()
    expect(requireOk(await fixture.manager.getDefault('codex'))).toBe('exec-1')

    // Wrong-agent or missing profiles cannot become the default.
    const wrongAgent = await fixture.manager.setDefault('claude', 'exec-1')
    expect(wrongAgent).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    const missing = await fixture.manager.setDefault('codex', 'exec-missing')
    expect(missing).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })

    expect(requireOk(await fixture.manager.setDefault('codex', null))).toBeUndefined()
    expect(requireOk(await fixture.manager.getDefault('codex'))).toBeUndefined()
  })

  it('clears the default when the default profile is removed', async () => {
    const fixture = setup()
    requireOk(await fixture.manager.create({ agentId: 'codex', name: 'P' }))
    requireOk(await fixture.manager.setDefault('codex', 'exec-1'))
    expect(requireOk(await fixture.manager.remove('exec-1'))).toBe(true)
    expect(requireOk(await fixture.manager.getDefault('codex'))).toBeUndefined()
  })

  describe('resolve (Run start, §14)', () => {
    it('returns the profile when it belongs to the requesting agent', async () => {
      const fixture = setup()
      requireOk(await fixture.manager.create({ agentId: 'codex', name: 'P', model: 'm' }))
      const resolved = requireOk(await fixture.manager.resolve('exec-1', 'codex'))
      expect(resolved).toMatchObject({ id: 'exec-1', agentId: 'codex', model: 'm' })
    })

    it('fails with EXECUTION_PROFILE_NOT_FOUND for a missing profile', async () => {
      const fixture = setup()
      const resolved = await fixture.manager.resolve('exec-missing', 'codex')
      expect(resolved).toMatchObject({ ok: false, error: { code: 'EXECUTION_PROFILE_NOT_FOUND' } })
    })

    it('fails with EXECUTION_PROFILE_MISMATCH for another agent’s profile', async () => {
      const fixture = setup()
      requireOk(await fixture.manager.create({ agentId: 'codex', name: 'P' }))
      const resolved = await fixture.manager.resolve('exec-1', 'claude')
      expect(resolved).toMatchObject({ ok: false, error: { code: 'EXECUTION_PROFILE_MISMATCH' } })
    })
  })
})
