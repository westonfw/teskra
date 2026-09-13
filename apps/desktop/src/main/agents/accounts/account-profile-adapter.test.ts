import { describe, expect, it } from 'vitest'

import type { IpcResult } from '@teskra/contracts'

import {
  createAccountProfileAdapterRegistry,
  type AgentAccountProfileAdapter,
} from './account-profile-adapter'

function stubAdapter(
  agentId: string,
  reservedEnvKeys: readonly string[],
): AgentAccountProfileAdapter {
  return {
    agentId,
    reservedEnvKeys,
    buildRuntimeProjection: (profile) => ({
      ok: true,
      data: { env: { [reservedEnvKeys[0] ?? 'HOME']: profile.configHome ?? '' } },
    }),
    detectStatus: () =>
      Promise.resolve<IpcResult<{ status: 'unknown' }>>({ ok: true, data: { status: 'unknown' } }),
    buildLoginCommand: () => ({ ok: true, data: { command: agentId, args: ['login'] } }),
  }
}

describe('AccountProfileAdapterRegistry (TASK-097, §10.4)', () => {
  it('registers adapters keyed by agentId (pluggable per agent)', () => {
    const created = createAccountProfileAdapterRegistry([
      stubAdapter('codex', ['CODEX_HOME']),
      stubAdapter('claude', ['CLAUDE_CONFIG_DIR']),
    ])
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const registry = created.data
    expect(registry.has('codex')).toBe(true)
    expect(registry.get('claude')?.reservedEnvKeys).toEqual(['CLAUDE_CONFIG_DIR'])
    expect(registry.get('kimi')).toBeUndefined()
  })

  it('rejects duplicate agent registrations', () => {
    const created = createAccountProfileAdapterRegistry()
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const registry = created.data
    expect(registry.register(stubAdapter('codex', ['CODEX_HOME'])).ok).toBe(true)
    const duplicate = registry.register(stubAdapter('codex', ['CODEX_HOME']))
    expect(duplicate.ok).toBe(false)
    if (duplicate.ok) return
    expect(duplicate.error.code).toBe('VALIDATION_FAILED')
  })
})
