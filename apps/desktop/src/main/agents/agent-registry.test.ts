import { describe, expect, it } from 'vitest'

import type { AgentDefinition } from '@teskra/contracts'

import {
  createAgentRegistry,
  createBuiltInAgentRegistry,
  createDefaultAgentRegistry,
} from './agent-registry'

const FAKE: AgentDefinition = {
  id: 'fake',
  name: 'Fake Agent',
  executable: { command: 'node', defaultArgs: ['tools/fake-agent.js'] },
  capabilities: {
    interactive: true,
    headless: true,
    resume: false,
    readOnlyMode: false,
    modelSelection: false,
  },
  prompt: {},
  detection: { versionArgs: ['--version'] },
  defaults: { role: 'tester' },
  permissionEnforcement: 'none',
  routing: { agentId: 'fake', strengths: ['testing'], costClass: 'low' },
}

describe('AgentRegistry', () => {
  it('ships Codex and Claude as validated definitions', () => {
    const created = createBuiltInAgentRegistry()
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.list().map(({ id }) => id)).toEqual(['codex', 'claude'])
  })

  it('accepts a third Agent without changing registry logic', () => {
    const created = createAgentRegistry()
    if (!created.ok) throw new Error('expected registry')
    expect(created.data.register(FAKE)).toEqual({ ok: true, data: FAKE })
    expect(created.data.get('fake')).toEqual(FAKE)
    expect(created.data.has('fake')).toBe(true)
  })

  it('registers Fake only for development and test composition', () => {
    const development = createDefaultAgentRegistry(true)
    const production = createDefaultAgentRegistry(false)
    if (!development.ok || !production.ok) throw new Error('expected registries')

    expect(development.data.list().map(({ id }) => id)).toEqual(['codex', 'claude', 'fake'])
    expect(production.data.list().map(({ id }) => id)).toEqual(['codex', 'claude'])
  })

  it('rejects malformed and duplicate definitions', () => {
    const created = createAgentRegistry([FAKE])
    if (!created.ok) throw new Error('expected registry')
    expect(created.data.register(FAKE)).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
    expect(createAgentRegistry([{ ...FAKE, routing: { agentId: 'other' } }])).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
  })

  it('rejects auditCommandPatterns that do not compile (P1-4)', () => {
    const invalid = createAgentRegistry([{ ...FAKE, auditCommandPatterns: [{ pattern: '([' }] }])
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    const invalidMarker = createAgentRegistry([
      { ...FAKE, auditCommandPatterns: [{ pattern: '^(.+)$', afterMarker: '*' }] },
    ])
    expect(invalidMarker).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('built-in Codex and Claude definitions declare their TUI audit patterns (P1-4)', () => {
    const created = createBuiltInAgentRegistry()
    if (!created.ok) throw new Error('expected registry')
    expect(created.data.get('codex')?.auditCommandPatterns?.length).toBeGreaterThan(0)
    expect(created.data.get('claude')?.auditCommandPatterns?.length).toBeGreaterThan(0)
  })
})
