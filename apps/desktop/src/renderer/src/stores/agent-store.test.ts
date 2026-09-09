import type { AgentDefinition } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createAgentStore, type AgentStoreBridge } from './agent-store'

const definitions: AgentDefinition[] = ['alpha', 'beta', 'fake'].map((id) => ({
  id,
  name: `${id} Agent`,
  executable: { command: id },
  capabilities: {
    interactive: true,
    headless: true,
    resume: false,
    readOnlyMode: false,
    modelSelection: false,
  },
  prompt: {},
  detection: { versionArgs: ['--version'] },
  defaults: {},
  permissionEnforcement: id === 'fake' ? 'none' : 'config',
  routing: { agentId: id },
}))

describe('Agent store', () => {
  it('renders its catalog from any Registry definitions, including a third Agent', async () => {
    const bridge: AgentStoreBridge = {
      agent: { listDefinitions: vi.fn(async () => ({ ok: true as const, data: definitions })) },
    }
    const store = createAgentStore(() => bridge)

    await store.getState().loadDefinitions()

    expect(store.getState().definitions.map(({ id }) => id)).toEqual(['alpha', 'beta', 'fake'])
    expect(bridge.agent.listDefinitions).toHaveBeenCalledOnce()
  })
})
