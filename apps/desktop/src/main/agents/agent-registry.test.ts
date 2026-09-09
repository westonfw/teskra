import { describe, expect, it } from 'vitest'

import type { AgentDefinition } from '@teskra/contracts'

import { createAgentRegistry, createBuiltInAgentRegistry } from './agent-registry'

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
})
