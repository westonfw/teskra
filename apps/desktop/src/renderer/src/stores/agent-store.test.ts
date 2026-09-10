import type {
  AgentDefinition,
  AgentRun,
  WorkbenchEventName,
  WorkbenchEvents,
} from '@teskra/contracts'
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

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    workspaceId: 'workspace-1',
    agentType: 'alpha',
    status: 'running',
    executionMode: 'attended',
    runDir: '/repo',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

function createBridge(initialRuns: AgentRun[] = []) {
  const handlers = new Map<WorkbenchEventName, Set<(payload: never) => void>>()
  let runs = initialRuns
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
          version: '1.0.0',
          overridden: true,
          fromCache: false,
          checkedAt: '2026-09-10T00:00:00.000Z',
        },
      })),
      listHealth: vi.fn(async ({ runtime }) => ({
        ok: true as const,
        data: definitions.map(({ id }) => ({
          agentId: id,
          runtime,
          installed: true,
          available: true,
          checkedAt: '2026-09-10T00:00:00.000Z',
        })),
      })),
      getExecutableOverride: vi.fn(async () => ({ ok: true as const, data: null })),
      setExecutableOverride: vi.fn(async ({ path }) => ({ ok: true as const, data: path })),
      start: vi.fn(async (request) => {
        const created = run({
          id: 'run-started',
          workspaceId: request.workspaceId,
          agentType: request.agentType,
          prompt: request.prompt,
        })
        runs = [created, ...runs]
        return { ok: true as const, data: created }
      }),
      cancel: vi.fn(async ({ runId }) => {
        const cancelled = run({ id: runId, status: 'cancelled' })
        runs = runs.map((item) => (item.id === runId ? cancelled : item))
        return { ok: true as const, data: cancelled }
      }),
      get: vi.fn(async ({ runId }) => ({
        ok: true as const,
        data: runs.find(({ id }) => id === runId) ?? null,
      })),
      list: vi.fn(async ({ workspaceId } = {}) => ({
        ok: true as const,
        data: runs.filter((item) => workspaceId === undefined || item.workspaceId === workspaceId),
      })),
    },
    events: {
      subscribe: vi.fn((name, handler) => {
        const listeners = handlers.get(name) ?? new Set()
        listeners.add(handler as (payload: never) => void)
        handlers.set(name, listeners)
        return () => listeners.delete(handler as (payload: never) => void)
      }),
    },
  }

  return {
    bridge,
    replaceRun(next: AgentRun) {
      runs = [next, ...runs.filter(({ id }) => id !== next.id)]
    },
    emit<Name extends WorkbenchEventName>(name: Name, payload: WorkbenchEvents[Name]) {
      for (const handler of handlers.get(name) ?? []) handler(payload as never)
    },
  }
}

describe('Agent store', () => {
  it('renders its catalog from any Registry definitions, including a third Agent', async () => {
    const { bridge } = createBridge()
    const store = createAgentStore(() => bridge)

    await store.getState().loadDefinitions()

    expect(store.getState().definitions.map(({ id }) => id)).toEqual(['alpha', 'beta', 'fake'])
    expect(bridge.agent.listDefinitions).toHaveBeenCalledOnce()
  })

  it('detects Agents and round-trips executable overrides by runtime target', async () => {
    const { bridge } = createBridge()
    const store = createAgentStore(() => bridge)
    const runtime = { kind: 'wsl' as const, distro: 'Ubuntu' }

    await store.getState().loadExecutableOverride('alpha', runtime)
    expect(await store.getState().setExecutableOverride('alpha', runtime, '/custom/agent')).toBe(
      true,
    )
    await store.getState().detect('alpha', runtime)
    await store.getState().loadHealth(runtime)

    expect(Object.values(store.getState().executableOverrides)).toContain('/custom/agent')
    expect(Object.values(store.getState().detections)[0]).toMatchObject({ installed: true })
    expect(Object.values(store.getState().health)).toHaveLength(3)
  })

  it('synchronizes run lifecycle events and the latest activity', async () => {
    const initial = run()
    const harness = createBridge([initial])
    const store = createAgentStore(() => harness.bridge)
    const stop = store.getState().startSynchronization('workspace-1')
    await vi.waitFor(() => expect(store.getState().runs).toEqual([initial]))

    harness.emit('agent.output', {
      runId: initial.id,
      data: '\u001b[32mBuilding project\u001b[0m\r\n',
    })
    harness.replaceRun(run({ status: 'completed', finishedAt: '2026-09-10T00:01:00.000Z' }))
    harness.emit('agent.completed', { runId: initial.id, exitCode: 0 })

    await vi.waitFor(() => expect(store.getState().runs[0]?.status).toBe('completed'))
    expect(store.getState().activity[initial.id]).toBe('Building project')
    expect(store.getState().output[initial.id]).toBe('\u001b[32mBuilding project\u001b[0m\r\n')
    stop()
  })

  it('starts and cancels runs through the typed Agent bridge', async () => {
    const { bridge } = createBridge()
    const store = createAgentStore(() => bridge)

    const started = await store.getState().startRun({
      workspaceId: 'workspace-1',
      agentType: 'fake',
      prompt: 'Test the project',
    })
    expect(started?.id).toBe('run-started')
    expect(store.getState().runs[0]?.prompt).toBe('Test the project')

    expect(await store.getState().cancelRun('run-started')).toBe(true)
    expect(store.getState().runs[0]?.status).toBe('cancelled')
  })

  it('bounds a 10 MiB-class output history while retaining the newest raw data', async () => {
    const initial = run()
    const harness = createBridge([initial])
    const store = createAgentStore(() => harness.bridge)
    const stop = store.getState().startSynchronization('workspace-1')
    await vi.waitFor(() => expect(store.getState().runs).toHaveLength(1))

    harness.emit('agent.output', { runId: initial.id, data: 'a'.repeat(6 * 1024 * 1024) })
    harness.emit('agent.output', { runId: initial.id, data: 'b'.repeat(6 * 1024 * 1024) })

    const output = store.getState().output[initial.id]
    expect(output).toHaveLength(10 * 1024 * 1024)
    expect(output?.startsWith('a')).toBe(true)
    expect(output?.endsWith('b')).toBe(true)
    stop()
  })
})
