import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CONFIG,
  type AgentDefinition,
  type AgentHealth,
  type AgentRole,
  type AgentRun,
  type ResolvedConfig,
  type TeskraConfigLayer,
  type Workspace,
} from '@teskra/contracts'

import { createAgentRegistry } from './agent-registry'
import {
  createDefaultSelectionService,
  RUN_DEFAULT_REASON_KEYS,
  type DefaultSelectionService,
} from './default-selection-service'

const WORKSPACE: Workspace = {
  id: 'ws1',
  name: 'Demo',
  runtime: { kind: 'windows' },
  path: '/repo',
  trustLevel: 'trusted',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

function defineAgent(
  id: string,
  options: { role?: AgentRole; priority?: number } = {},
): AgentDefinition {
  return {
    id,
    name: `Agent ${id}`,
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
    defaults: options.role === undefined ? {} : { role: options.role },
    permissionEnforcement: 'none',
    routing: { agentId: id, priority: options.priority ?? 0 },
  }
}

function healthOf(
  agentId: string,
  options: { installed?: boolean; available?: boolean; rateLimited?: boolean } = {},
): AgentHealth {
  const installed = options.installed ?? true
  return {
    agentId,
    runtime: { kind: 'windows' },
    installed,
    available: options.available ?? installed,
    ...(options.rateLimited === undefined ? {} : { rateLimited: options.rateLimited }),
    checkedAt: '2026-09-10T00:00:00.000Z',
  }
}

function completedRun(agentType: string): AgentRun {
  return {
    id: `run-${agentType}`,
    workspaceId: WORKSPACE.id,
    agentType,
    status: 'completed',
    executionMode: 'orchestrated',
    runDir: `/data/runs/run-${agentType}`,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  }
}

function resolvedConfig(layer: TeskraConfigLayer = {}): ResolvedConfig {
  // layer.agents is a partial group: undefined fields keep the default, an
  // explicit null (defaultAgent) must win.
  const agents = { ...DEFAULT_CONFIG.agents }
  for (const [key, value] of Object.entries(layer.agents ?? {})) {
    if (value !== undefined) {
      ;(agents as Record<string, unknown>)[key] = value
    }
  }
  return {
    config: {
      ...DEFAULT_CONFIG,
      agents,
    },
    sources: {},
    warnings: [],
  }
}

interface FixtureOptions {
  readonly definitions?: readonly AgentDefinition[]
  readonly health?: readonly AgentHealth[]
  readonly lastSuccessful?: AgentRun | null
  readonly accountDefaults?: Readonly<Record<string, string>>
  readonly configLayer?: TeskraConfigLayer
}

function fixture(options: FixtureOptions = {}): { service: DefaultSelectionService } {
  const created = createAgentRegistry(options.definitions ?? [])
  if (!created.ok) throw new Error(`registry setup failed: ${created.error.message}`)
  const service = createDefaultSelectionService({
    registry: created.data,
    health: {
      list: async () => ({ ok: true, data: options.health ?? [] }),
    },
    runs: {
      findLastSuccessfulByWorkspace: () => ({ ok: true, data: options.lastSuccessful ?? null }),
    },
    accounts: {
      getDefault: async (agentId) => ({
        ok: true,
        data: options.accountDefaults?.[agentId],
      }),
    },
    config: {
      resolve: () => ({ ok: true, data: resolvedConfig(options.configLayer) }),
    },
    workspaces: {
      getById: (id) => ({ ok: true, data: id === WORKSPACE.id ? WORKSPACE : null }),
    },
  })
  return { service }
}

async function resolveDefaults(
  service: DefaultSelectionService,
  role?: AgentRole,
): ReturnType<DefaultSelectionService['resolveDefaults']> {
  return service.resolveDefaults({
    workspaceId: WORKSPACE.id,
    ...(role === undefined ? {} : { role }),
  })
}

describe('DefaultSelectionService (TASK-134)', () => {
  it('level 1: picks the configured agents.defaultAgent, even over the last successful run', async () => {
    const { service } = fixture({
      definitions: [defineAgent('agent-a'), defineAgent('agent-b')],
      health: [healthOf('agent-a'), healthOf('agent-b')],
      lastSuccessful: completedRun('agent-b'),
      configLayer: { agents: { defaultAgent: 'agent-a' } },
    })
    const result = await resolveDefaults(service)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.agentType).toBe('agent-a')
    expect(result.data.reasons[0]).toEqual({
      key: RUN_DEFAULT_REASON_KEYS.agentConfigured,
      params: { agent: 'agent-a' },
    })
  })

  it('level 1: skips a configured defaultAgent that is not registered', async () => {
    const { service } = fixture({
      definitions: [defineAgent('agent-b', { role: 'implementer' })],
      health: [healthOf('agent-b')],
      lastSuccessful: completedRun('agent-b'),
      configLayer: { agents: { defaultAgent: 'ghost-agent' } },
    })
    const result = await resolveDefaults(service)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.agentType).toBe('agent-b')
    expect(result.data.reasons[0]).toEqual({
      key: RUN_DEFAULT_REASON_KEYS.agentLastSuccessfulRun,
      params: { agent: 'agent-b' },
    })
  })

  it('level 2: picks the Agent of the workspace’s most recent successful run', async () => {
    const { service } = fixture({
      definitions: [defineAgent('agent-a'), defineAgent('agent-b')],
      health: [healthOf('agent-a'), healthOf('agent-b')],
      lastSuccessful: completedRun('agent-b'),
    })
    const result = await resolveDefaults(service)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.agentType).toBe('agent-b')
    expect(result.data.reasons[0]).toEqual({
      key: RUN_DEFAULT_REASON_KEYS.agentLastSuccessfulRun,
      params: { agent: 'agent-b' },
    })
  })

  it('level 3: picks the highest-priority healthy Agent matching the role', async () => {
    const { service } = fixture({
      definitions: [
        defineAgent('agent-low', { role: 'implementer', priority: 10 }),
        defineAgent('agent-high', { role: 'implementer', priority: 90 }),
        defineAgent('agent-reviewer', { role: 'reviewer', priority: 100 }),
      ],
      health: [healthOf('agent-low'), healthOf('agent-high'), healthOf('agent-reviewer')],
    })
    const result = await resolveDefaults(service)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.agentType).toBe('agent-high')
    expect(result.data.reasons[0]).toEqual({
      key: RUN_DEFAULT_REASON_KEYS.agentRoleMatch,
      params: { agent: 'agent-high', role: 'implementer' },
    })
  })

  it('level 3: honors the requested role', async () => {
    const { service } = fixture({
      definitions: [
        defineAgent('agent-impl', { role: 'implementer', priority: 100 }),
        defineAgent('agent-rev', { role: 'reviewer', priority: 10 }),
      ],
      health: [healthOf('agent-impl'), healthOf('agent-rev')],
    })
    const result = await resolveDefaults(service, 'reviewer')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.agentType).toBe('agent-rev')
    expect(result.data.reasons[0]).toEqual({
      key: RUN_DEFAULT_REASON_KEYS.agentRoleMatch,
      params: { agent: 'agent-rev', role: 'reviewer' },
    })
  })

  it('health filter: unavailable and rate-limited role matches are excluded from level 3', async () => {
    const { service } = fixture({
      definitions: [
        defineAgent('agent-down', { role: 'implementer', priority: 100 }),
        defineAgent('agent-limited', { role: 'implementer', priority: 90 }),
        defineAgent('agent-ok', { role: 'implementer', priority: 10 }),
      ],
      health: [
        healthOf('agent-down', { available: false }),
        healthOf('agent-limited', { rateLimited: true }),
        healthOf('agent-ok'),
      ],
    })
    const result = await resolveDefaults(service)
    expect(result).toMatchObject({ ok: true, data: { agentType: 'agent-ok' } })
    if (!result.ok) return
    expect(result.data.reasons[0]).toEqual({
      key: RUN_DEFAULT_REASON_KEYS.agentRoleMatch,
      params: { agent: 'agent-ok', role: 'implementer' },
    })
  })

  it('level 4: without a healthy role match, picks the highest-priority installed Agent', async () => {
    const { service } = fixture({
      definitions: [
        defineAgent('agent-reviewer', { role: 'reviewer', priority: 100 }),
        defineAgent('agent-limited', { role: 'implementer', priority: 90 }),
        defineAgent('agent-plain', { priority: 10 }),
      ],
      health: [
        healthOf('agent-reviewer'),
        healthOf('agent-limited', { rateLimited: true }),
        healthOf('agent-plain'),
        healthOf('agent-absent', { installed: false }),
      ],
    })
    const result = await resolveDefaults(service)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.agentType).toBe('agent-reviewer')
    expect(result.data.reasons[0]).toEqual({
      key: RUN_DEFAULT_REASON_KEYS.agentInstalledFallback,
      params: { agent: 'agent-reviewer' },
    })
  })

  it('level 5: VALIDATION_FAILED when no Agent is installed', async () => {
    const { service } = fixture({
      definitions: [defineAgent('agent-a', { role: 'implementer', priority: 100 })],
      health: [healthOf('agent-a', { installed: false, available: false })],
    })
    const result = await resolveDefaults(service)
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('fills accountProfileId from AccountProfileManager.getDefault and executionProfileId from config', async () => {
    const { service } = fixture({
      definitions: [defineAgent('agent-a', { role: 'implementer' })],
      health: [healthOf('agent-a')],
      accountDefaults: { 'agent-a': 'acct-1' },
      configLayer: {
        agents: { defaultExecutionProfiles: { 'agent-a': 'exec-1' } },
      },
    })
    const result = await resolveDefaults(service)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.agentType).toBe('agent-a')
    expect(result.data.accountProfileId).toBe('acct-1')
    expect(result.data.executionProfileId).toBe('exec-1')
    expect(result.data.reasons).toEqual([
      {
        key: RUN_DEFAULT_REASON_KEYS.agentRoleMatch,
        params: { agent: 'agent-a', role: 'implementer' },
      },
      {
        key: RUN_DEFAULT_REASON_KEYS.accountProfileDefault,
        params: { agent: 'agent-a', profileId: 'acct-1' },
      },
      {
        key: RUN_DEFAULT_REASON_KEYS.executionProfileDefault,
        params: { agent: 'agent-a', profileId: 'exec-1' },
      },
      { key: RUN_DEFAULT_REASON_KEYS.modeFixed, params: { mode: 'exec' } },
      {
        key: RUN_DEFAULT_REASON_KEYS.executionModeFixed,
        params: { executionMode: 'orchestrated' },
      },
      { key: RUN_DEFAULT_REASON_KEYS.approvalModeFixed, params: { approvalMode: 'safe-auto' } },
      { key: RUN_DEFAULT_REASON_KEYS.isolationFixed, params: { isolation: 'worktree' } },
    ])
  })

  it('omits profile ids and explains the absence when no defaults exist', async () => {
    const { service } = fixture({
      definitions: [defineAgent('agent-a', { role: 'implementer' })],
      health: [healthOf('agent-a')],
    })
    const result = await resolveDefaults(service)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.accountProfileId).toBeUndefined()
    expect(result.data.executionProfileId).toBeUndefined()
    expect(result.data.reasons).toEqual([
      {
        key: RUN_DEFAULT_REASON_KEYS.agentRoleMatch,
        params: { agent: 'agent-a', role: 'implementer' },
      },
      { key: RUN_DEFAULT_REASON_KEYS.accountProfileNone, params: { agent: 'agent-a' } },
      { key: RUN_DEFAULT_REASON_KEYS.executionProfileNone, params: { agent: 'agent-a' } },
      { key: RUN_DEFAULT_REASON_KEYS.modeFixed, params: { mode: 'exec' } },
      {
        key: RUN_DEFAULT_REASON_KEYS.executionModeFixed,
        params: { executionMode: 'orchestrated' },
      },
      { key: RUN_DEFAULT_REASON_KEYS.approvalModeFixed, params: { approvalMode: 'safe-auto' } },
      { key: RUN_DEFAULT_REASON_KEYS.isolationFixed, params: { isolation: 'worktree' } },
    ])
  })

  it('pins the fixed defaults: exec / orchestrated / safe-auto / worktree', async () => {
    const { service } = fixture({
      definitions: [defineAgent('agent-a', { role: 'implementer' })],
      health: [healthOf('agent-a')],
    })
    const result = await resolveDefaults(service)
    expect(result).toMatchObject({
      ok: true,
      data: {
        mode: 'exec',
        executionMode: 'orchestrated',
        approvalMode: 'safe-auto',
        isolation: 'worktree',
      },
    })
  })

  it('returns WORKSPACE_NOT_FOUND for an unknown workspace', async () => {
    const { service } = fixture({
      definitions: [defineAgent('agent-a')],
      health: [healthOf('agent-a')],
    })
    const result = await service.resolveDefaults({ workspaceId: 'missing' })
    expect(result).toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } })
  })

  it('workflow defaults: implementer resolves with role implementer; reviewers are healthy reviewer-role Agents minus the implementer', async () => {
    const { service } = fixture({
      definitions: [
        defineAgent('agent-impl', { role: 'implementer', priority: 100 }),
        defineAgent('agent-rev-a', { role: 'reviewer', priority: 80 }),
        defineAgent('agent-rev-b', { role: 'reviewer', priority: 60 }),
        defineAgent('agent-rev-down', { role: 'reviewer', priority: 70 }),
      ],
      health: [
        healthOf('agent-impl'),
        healthOf('agent-rev-a'),
        healthOf('agent-rev-b'),
        healthOf('agent-rev-down', { available: false }),
      ],
    })
    const result = await service.resolveWorkflowDefaults(WORKSPACE.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.implementer.agentType).toBe('agent-impl')
    // Highest priority first; the unavailable reviewer is filtered out.
    expect(result.data.reviewers).toEqual(['agent-rev-a', 'agent-rev-b'])
  })

  it('workflow defaults: an implementer selected outside the role path is removed from reviewers', async () => {
    const { service } = fixture({
      definitions: [
        defineAgent('agent-rev', { role: 'reviewer', priority: 100 }),
        defineAgent('agent-rev-b', { role: 'reviewer', priority: 60 }),
      ],
      health: [healthOf('agent-rev'), healthOf('agent-rev-b')],
      // The configured default is a reviewer-role Agent: it becomes the
      // implementer (level 1) and must not also review.
      configLayer: { agents: { defaultAgent: 'agent-rev' } },
    })
    const result = await service.resolveWorkflowDefaults(WORKSPACE.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.implementer.agentType).toBe('agent-rev')
    expect(result.data.reviewers).toEqual(['agent-rev-b'])
  })

  it('workflow defaults: VALIDATION_FAILED when no Agent can implement', async () => {
    const { service } = fixture({
      definitions: [defineAgent('agent-a', { role: 'implementer' })],
      health: [healthOf('agent-a', { installed: false, available: false })],
    })
    const result = await service.resolveWorkflowDefaults(WORKSPACE.id)
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })
})
