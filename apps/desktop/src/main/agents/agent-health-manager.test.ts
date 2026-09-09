import { describe, expect, it, vi } from 'vitest'

import type { AgentDetectionResult, IpcResult } from '@teskra/contracts'

import { createDefaultAgentRegistry } from './agent-registry'
import { createAgentHealthManager } from './agent-health-manager'

function registry(includeFake = false) {
  const created = createDefaultAgentRegistry(includeFake)
  if (!created.ok) throw new Error('expected Agent Registry')
  return created.data
}

function detected(agentId: string, installed = true): IpcResult<AgentDetectionResult> {
  return {
    ok: true,
    data: {
      agentId,
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      installed,
      ...(installed
        ? { executable: `/usr/bin/${agentId}`, version: `${agentId} 1.0` }
        : { error: `${agentId} was not found` }),
      overridden: false,
      fromCache: false,
      checkedAt: '2026-09-10T00:00:00.000Z',
    },
  }
}

describe('AgentHealthManager (TASK-024)', () => {
  it('maps a successful detection to available health without requiring quota data', async () => {
    const manager = createAgentHealthManager({
      registry: registry(),
      detector: { detect: vi.fn(async ({ agentId }) => detected(agentId)) },
    })
    const result = await manager.check({ agentId: 'codex', runtime: { kind: 'wsl' } })

    expect(result).toMatchObject({
      ok: true,
      data: { installed: true, available: true, executable: '/usr/bin/codex' },
    })
    if (result.ok) expect(result.data).not.toHaveProperty('quota')
  })

  it('reports an uninstalled Agent explicitly', async () => {
    const manager = createAgentHealthManager({
      registry: registry(),
      detector: { detect: vi.fn(async ({ agentId }) => detected(agentId, false)) },
    })
    expect(await manager.check({ agentId: 'claude', runtime: { kind: 'wsl' } })).toMatchObject({
      ok: true,
      data: { installed: false, available: false, error: expect.any(String) },
    })
  })

  it('isolates one failed health check and continues checking every other Agent', async () => {
    const manager = createAgentHealthManager({
      registry: registry(true),
      detector: {
        detect: vi.fn(async ({ agentId }) => {
          if (agentId === 'claude') throw new Error('probe crashed')
          return detected(agentId)
        }),
      },
      now: () => Date.parse('2026-09-10T00:00:00.000Z'),
    })
    const result = await manager.list({ runtime: { kind: 'wsl', distro: 'Ubuntu' } })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveLength(3)
    expect(result.data.find(({ agentId }) => agentId === 'codex')?.available).toBe(true)
    expect(result.data.find(({ agentId }) => agentId === 'claude')).toMatchObject({
      installed: false,
      available: false,
    })
    expect(result.data.find(({ agentId }) => agentId === 'fake')?.available).toBe(true)
  })
})
