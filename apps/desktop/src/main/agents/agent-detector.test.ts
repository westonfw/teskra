import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_CONFIG, type TeskraConfigLayer } from '@teskra/contracts'

import type { ConfigService } from '../config/config-service'
import type { CommandRequest, CommandRunner } from '../process/command-runner'
import { createWorkspaceRuntime } from '../workspace/runtime'
import { createBuiltInAgentRegistry } from './agent-registry'
import { createAgentDetector } from './agent-detector'

function registry() {
  const created = createBuiltInAgentRegistry()
  if (!created.ok) throw new Error('expected Agent Registry')
  return created.data
}

function config() {
  const overrides: Record<string, string | null> = {}
  const service: Pick<ConfigService, 'resolve' | 'updateGlobal'> = {
    resolve: () => ({
      ok: true,
      data: {
        config: {
          ...DEFAULT_CONFIG,
          agents: {
            executableOverrides: { ...overrides },
            defaultAccountProfiles: {},
            defaultExecutionProfiles: {},
          },
        },
        sources: {},
        warnings: [],
      },
    }),
    updateGlobal: (patch: unknown) => {
      const layer = patch as TeskraConfigLayer
      Object.assign(overrides, layer.agents?.executableOverrides)
      return service.resolve()
    },
  }
  return service
}

function runner(
  respond: (request: CommandRequest) => { stdout: string; stderr?: string; exitCode: number },
) {
  const run = vi.fn(async (request: CommandRequest) => {
    const result = respond(request)
    return {
      ok: true as const,
      data: { stdout: result.stdout, stderr: result.stderr ?? '', exitCode: result.exitCode },
    }
  })
  return { run } satisfies CommandRunner
}

describe('AgentDetector (TASK-023)', () => {
  it('locates a Windows Agent with where.exe and returns its path and version', async () => {
    const commands = runner((request) =>
      request.command === 'where.exe'
        ? { stdout: 'C:\\Tools\\codex.exe\r\n', exitCode: 0 }
        : { stdout: 'codex-cli 1.2.3\n', exitCode: 0 },
    )
    const detector = createAgentDetector({
      registry: registry(),
      commands,
      config: config(),
      resolveRuntime: (ref) => createWorkspaceRuntime(ref, { hostPlatform: 'win32' }),
      now: () => Date.parse('2026-09-10T00:00:00.000Z'),
    })

    const result = await detector.detect({ agentId: 'codex', runtime: { kind: 'windows' } })
    expect(result).toMatchObject({
      ok: true,
      data: {
        installed: true,
        executable: 'C:\\Tools\\codex.exe',
        version: 'codex-cli 1.2.3',
        fromCache: false,
      },
    })
    expect(commands.run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: 'where.exe', args: ['codex'] }),
    )
  })

  it('uses which in a WSL/POSIX runtime and caches the detection result', async () => {
    const commands = runner((request) =>
      request.command === 'which'
        ? { stdout: '/usr/local/bin/claude\n', exitCode: 0 }
        : { stdout: '2.1.0 (Claude Code)\n', exitCode: 0 },
    )
    const detector = createAgentDetector({
      registry: registry(),
      commands,
      config: config(),
      resolveRuntime: (ref) => createWorkspaceRuntime(ref, { hostPlatform: 'linux' }),
    })

    const request = { agentId: 'claude', runtime: { kind: 'wsl' as const, distro: 'Ubuntu' } }
    const first = await detector.detect(request)
    const second = await detector.detect(request)
    expect(first).toMatchObject({ ok: true, data: { installed: true, fromCache: false } })
    expect(second).toMatchObject({ ok: true, data: { installed: true, fromCache: true } })
    expect(commands.run).toHaveBeenCalledTimes(2)
    expect(commands.run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: 'which', args: ['claude'] }),
    )
  })

  it('reads and writes a runtime-specific path override and invalidates cache', async () => {
    const commands = runner(() => ({ stdout: 'custom 1.0\n', exitCode: 0 }))
    const settings = config()
    const detector = createAgentDetector({
      registry: registry(),
      commands,
      config: settings,
      resolveRuntime: (ref) => createWorkspaceRuntime(ref, { hostPlatform: 'linux' }),
    })
    const target = { agentId: 'codex', runtime: { kind: 'wsl' as const, distro: 'Debian' } }

    expect(detector.getExecutableOverride(target)).toEqual({ ok: true, data: null })
    expect(detector.setExecutableOverride({ ...target, path: '/opt/codex' })).toEqual({
      ok: true,
      data: '/opt/codex',
    })
    expect(detector.getExecutableOverride(target)).toEqual({ ok: true, data: '/opt/codex' })
    const detected = await detector.detect(target)
    expect(detected).toMatchObject({
      ok: true,
      data: { executable: '/opt/codex', overridden: true },
    })
    expect(commands.run).toHaveBeenCalledOnce()

    expect(detector.setExecutableOverride({ ...target, path: null })).toEqual({
      ok: true,
      data: null,
    })
    expect(detector.getExecutableOverride(target)).toEqual({ ok: true, data: null })
  })

  it('returns installed=false without failing the IPC operation when lookup misses', async () => {
    const detector = createAgentDetector({
      registry: registry(),
      commands: runner(() => ({ stdout: '', exitCode: 1 })),
      config: config(),
      resolveRuntime: (ref) => createWorkspaceRuntime(ref, { hostPlatform: 'linux' }),
    })
    expect(await detector.detect({ agentId: 'codex', runtime: { kind: 'wsl' } })).toMatchObject({
      ok: true,
      data: { installed: false, error: expect.any(String) },
    })
  })

  it('skips the extension-less npm shim line and picks the .cmd shim on Windows', async () => {
    const commands = runner((request) =>
      request.command === 'where.exe'
        ? {
            stdout:
              'C:\\Users\\u\\AppData\\Roaming\\npm\\codex\r\n' +
              'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd\r\n' +
              'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.ps1\r\n',
            exitCode: 0,
          }
        : { stdout: 'codex-cli 1.2.3\n', exitCode: 0 },
    )
    const detector = createAgentDetector({
      registry: registry(),
      commands,
      config: config(),
      resolveRuntime: (ref) => createWorkspaceRuntime(ref, { hostPlatform: 'win32' }),
    })

    const result = await detector.detect({ agentId: 'codex', runtime: { kind: 'windows' } })
    expect(result).toMatchObject({
      ok: true,
      data: {
        installed: true,
        executable: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd',
        version: 'codex-cli 1.2.3',
      },
    })
    // The version probe runs against the .cmd shim, not the bash shim.
    expect(commands.run).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd',
        args: ['--version'],
      }),
    )
  })

  it('prefers a real .exe over .cmd shims regardless of line order', async () => {
    const commands = runner((request) =>
      request.command === 'where.exe'
        ? {
            stdout: 'C:\\npm\\codex.cmd\r\nC:\\Tools\\codex.exe\r\n',
            exitCode: 0,
          }
        : { stdout: 'codex-cli 1.2.3\n', exitCode: 0 },
    )
    const detector = createAgentDetector({
      registry: registry(),
      commands,
      config: config(),
      resolveRuntime: (ref) => createWorkspaceRuntime(ref, { hostPlatform: 'win32' }),
    })

    const result = await detector.detect({ agentId: 'codex', runtime: { kind: 'windows' } })
    expect(result).toMatchObject({
      ok: true,
      data: { installed: true, executable: 'C:\\Tools\\codex.exe' },
    })
  })

  it('reports installed=false when where.exe only finds non-executable shims', async () => {
    const commands = runner(() => ({
      stdout:
        'C:\\Users\\u\\AppData\\Roaming\\npm\\codex\r\nC:\\Users\\u\\AppData\\Roaming\\npm\\codex.ps1\r\n',
      exitCode: 0,
    }))
    const detector = createAgentDetector({
      registry: registry(),
      commands,
      config: config(),
      resolveRuntime: (ref) => createWorkspaceRuntime(ref, { hostPlatform: 'win32' }),
    })

    const result = await detector.detect({ agentId: 'codex', runtime: { kind: 'windows' } })
    expect(result).toMatchObject({ ok: true, data: { installed: false } })
    if (!result.ok) return
    expect(result.data.error).toContain('shim')
    // No version probe is attempted when nothing executable was found.
    expect(commands.run).toHaveBeenCalledTimes(1)
  })
})
