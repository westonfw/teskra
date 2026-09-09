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
      agent: {
        listDefinitions: vi.fn(async () => ({ ok: true as const, data: definitions })),
        detect: vi.fn(async ({ agentId, runtime }) => ({
          ok: true as const,
          data: {
            agentId,
            runtime,
            installed: true,
            executable: '/bin/agent',
            version: '1.0.0',
            overridden: false,
            fromCache: false,
            checkedAt: '2026-09-10T00:00:00.000Z',
          },
        })),
        getExecutableOverride: vi.fn(async () => ({ ok: true as const, data: null })),
        setExecutableOverride: vi.fn(async ({ path }) => ({ ok: true as const, data: path })),
      },
    }
    const store = createAgentStore(() => bridge)

    await store.getState().loadDefinitions()

    expect(store.getState().definitions.map(({ id }) => id)).toEqual(['alpha', 'beta', 'fake'])
    expect(bridge.agent.listDefinitions).toHaveBeenCalledOnce()
  })

  it('detects Agents and round-trips executable overrides by runtime target', async () => {
    const bridge: AgentStoreBridge = {
      agent: {
        listDefinitions: vi.fn(async () => ({ ok: true as const, data: definitions })),
        detect: vi.fn(async ({ agentId, runtime }) => ({
          ok: true as const,
          data: {
            agentId,
            runtime,
            installed: true,
            executable: '/custom/agent',
            overridden: true,
            fromCache: false,
            checkedAt: '2026-09-10T00:00:00.000Z',
          },
        })),
        getExecutableOverride: vi.fn(async () => ({ ok: true as const, data: null })),
        setExecutableOverride: vi.fn(async ({ path }) => ({ ok: true as const, data: path })),
      },
    }
    const store = createAgentStore(() => bridge)
    const runtime = { kind: 'wsl' as const, distro: 'Ubuntu' }

    await store.getState().loadExecutableOverride('alpha', runtime)
    expect(await store.getState().setExecutableOverride('alpha', runtime, '/custom/agent')).toBe(
      true,
    )
    await store.getState().detect('alpha', runtime)

    expect(Object.values(store.getState().executableOverrides)).toContain('/custom/agent')
    expect(Object.values(store.getState().detections)[0]).toMatchObject({ installed: true })
  })
})
