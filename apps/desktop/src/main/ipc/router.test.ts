import { describe, expect, it, vi } from 'vitest'

import {
  IPC_CHANNELS,
  ipcChannelDefinitions,
  type IpcResult,
  type Workspace,
} from '@teskra/contracts'

import type { TeskraRuntime } from '../runtime/facade'
import { registerIpcRouter, type IpcMainPort } from './router'
import { createEventBus } from '../events/event-bus'

class FakeIpcMain implements IpcMainPort {
  readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`)
    this.handlers.set(channel, listener)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  async invoke(channel: string, payload?: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (handler === undefined) throw new Error(`missing handler: ${channel}`)
    return handler({}, payload)
  }
}

const WORKSPACE: Workspace = {
  id: 'ws1',
  name: 'Demo',
  runtime: { kind: 'wsl', distro: 'Ubuntu' },
  path: '/repo',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function fakeRuntime(): TeskraRuntime {
  return {
    events: createEventBus(),
    workspace: {
      create: vi.fn(() => ok(WORKSPACE)),
      open: vi.fn(() => ok(WORKSPACE)),
      remove: vi.fn(() => ok(true)),
      listRecent: vi.fn(() => ok([WORKSPACE])),
      validate: vi.fn(() => ok({ exists: true })),
      selectDirectory: vi.fn(async () => ok('/repo')),
    },
    terminal: {
      create: vi.fn(() =>
        ok({
          id: 'term1',
          workspaceId: 'ws1',
          shell: 'bash' as const,
          processId: 'proc1',
          title: 'Bash',
          createdAt: '2026-09-10T00:00:00.000Z',
        }),
      ),
      write: vi.fn(() => ok(undefined)),
      resize: vi.fn(() => ok(undefined)),
      close: vi.fn(async () => ok(undefined)),
      get: vi.fn(() => ok(null)),
      list: vi.fn(() => ok([])),
    },
    agent: {
      listDefinitions: vi.fn(() => ok([])),
    },
    system: {
      info: vi.fn(() => ok({ appVersion: '0.1.0', runtimeVersion: '22.0.0' })),
      paths: vi.fn(() =>
        ok({
          dataDirectory: '/data',
          logDirectory: '/data/logs',
          databaseFile: '/data/db',
        }),
      ),
      health: vi.fn(async () => ok({ databaseAvailable: true, wslAvailable: true, issues: [] })),
      inspectWsl: vi.fn(async () => ok({ supportsCd: true, distributions: [] })),
      listWslDistributions: vi.fn(async () => ok([])),
      getDefaultWslDistribution: vi.fn(async () => ok<string | null>(null)),
      setDefaultWslDistribution: vi.fn(async (name: string | null) => ok(name)),
    },
    settings: {
      resolveConfig: vi.fn(() =>
        ok({
          config: {
            logging: { level: 'info' as const },
            concurrency: { maxGlobalRuns: 4, maxRunsPerWorkspace: 3, maxRunsPerAgent: 2 },
            watchdog: { stalledThresholdMs: 600_000 },
            environment: { defaultDistro: null },
          },
          sources: {
            'logging.level': 'default' as const,
            'concurrency.maxGlobalRuns': 'default' as const,
            'concurrency.maxRunsPerWorkspace': 'default' as const,
            'concurrency.maxRunsPerAgent': 'default' as const,
            'watchdog.stalledThresholdMs': 'default' as const,
            'environment.defaultDistro': 'default' as const,
          },
          warnings: [],
        }),
      ),
      updateConfig: vi.fn(() =>
        ok({
          config: {
            logging: { level: 'warn' as const },
            concurrency: { maxGlobalRuns: 4, maxRunsPerWorkspace: 3, maxRunsPerAgent: 2 },
            watchdog: { stalledThresholdMs: 600_000 },
            environment: { defaultDistro: null },
          },
          sources: { 'logging.level': 'global' as const },
          warnings: [],
        }),
      ),
      openDirectory: vi.fn(async () => ok(undefined)),
    },
    dispose: vi.fn(() => ok(undefined)),
  }
}

describe('Typed IPC Router (TASK-020)', () => {
  it('registers every shared channel and exposes no generic exec endpoint', () => {
    const ipc = new FakeIpcMain()
    registerIpcRouter(ipc, fakeRuntime)

    expect([...ipc.handlers.keys()].sort()).toEqual(
      Object.values(ipcChannelDefinitions)
        .map((definition) => definition.channel)
        .sort(),
    )
    expect(Object.keys(IPC_CHANNELS).some((name) => /exec/iu.test(name))).toBe(false)
    expect(Object.values(IPC_CHANNELS).some((name) => /:exec(?::|$)/u.test(name))).toBe(false)
  })

  it('validates every request before invoking the Facade', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    const invalid = await ipc.invoke(IPC_CHANNELS.workspaceCreate, {
      name: 'Missing runtime and path',
    })
    expect(invalid).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: `Invalid request for IPC channel "${IPC_CHANNELS.workspaceCreate}".`,
        retryable: false,
      },
    })
    expect(runtime.workspace.create).not.toHaveBeenCalled()

    const valid = await ipc.invoke(IPC_CHANNELS.workspaceCreate, {
      name: 'Demo',
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      path: '/repo',
    })
    expect(valid).toEqual({ ok: true, data: WORKSPACE })
    expect(runtime.workspace.create).toHaveBeenCalledTimes(1)
  })

  it('returns structured capability errors while runtime is unavailable', async () => {
    const ipc = new FakeIpcMain()
    registerIpcRouter(ipc, () => undefined)

    expect(await ipc.invoke(IPC_CHANNELS.ping)).toEqual({ ok: true, data: 'pong' })
    const result = await ipc.invoke(IPC_CHANNELS.terminalList, {})
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'CAPABILITY_NOT_AVAILABLE',
        message: 'Teskra Runtime is not available.',
        retryable: true,
      },
    })
  })

  it('lists Agent definitions through the runtime facade', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    registerIpcRouter(ipc, () => runtime)

    expect(await ipc.invoke(IPC_CHANNELS.agentListDefinitions)).toEqual({ ok: true, data: [] })
    expect(runtime.agent.listDefinitions).toHaveBeenCalledOnce()
  })

  it('validates Facade responses and converts thrown errors', async () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    runtime.workspace.remove = vi.fn(() => ({
      ok: true,
      data: 'not boolean',
    })) as unknown as (request: { id: string }) => IpcResult<boolean>
    runtime.workspace.open = vi.fn(() => {
      throw new Error('boom')
    })
    registerIpcRouter(ipc, () => runtime)

    const malformed = await ipc.invoke(IPC_CHANNELS.workspaceRemove, { id: 'ws1' })
    expect(malformed).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
    const thrown = await ipc.invoke(IPC_CHANNELS.workspaceOpen, {
      runtime: { kind: 'wsl' },
      path: '/repo',
    })
    expect(thrown).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })
  })

  it('removes all handlers on dispose without touching the runtime', () => {
    const ipc = new FakeIpcMain()
    const runtime = fakeRuntime()
    const router = registerIpcRouter(ipc, () => runtime)
    router.dispose()
    router.dispose()
    expect(ipc.handlers.size).toBe(0)
    expect(runtime.dispose).not.toHaveBeenCalled()
  })
})
