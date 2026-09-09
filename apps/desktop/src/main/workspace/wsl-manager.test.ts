import { describe, expect, it } from 'vitest'

import { DEFAULT_CONFIG, teskraConfigLayerSchema } from '@teskra/contracts'

import type { ConfigService } from '../config/config-service'
import type { CommandRequest, CommandResult, CommandRunner } from '../process/command-runner'
import {
  cleanWslOutput,
  createWslManager,
  parseWslDefaultDistribution,
  parseWslDistributionNames,
  parseWslVersion,
} from './wsl-manager'

const success = (stdout: string, exitCode = 0): { ok: true; data: CommandResult } => ({
  ok: true,
  data: { stdout, stderr: '', exitCode },
})

function fakeCommands(
  responses: Partial<Record<'status' | 'list' | 'version', ReturnType<typeof success>>> = {},
): { runner: CommandRunner; requests: CommandRequest[] } {
  const requests: CommandRequest[] = []
  return {
    requests,
    runner: {
      async run(request) {
        requests.push(request)
        const key = request.args?.includes('--status')
          ? 'status'
          : request.args?.includes('--version')
            ? 'version'
            : 'list'
        return (
          responses[key] ??
          (key === 'status'
            ? success('Default Distribution: Ubuntu-24.04\r\n')
            : key === 'version'
              ? success('WSL version: 2.4.11.0\r\nKernel version: 6.6.87.2\r\n')
              : success('Ubuntu-24.04\r\nDebian\r\n'))
        )
      },
    },
  }
}

function fakeConfig(initial: string | null = null): {
  config: Pick<ConfigService, 'resolve' | 'updateGlobal'>
  getValue(): string | null
} {
  let defaultDistro = initial
  const resolve: ConfigService['resolve'] = () => ({
    ok: true,
    data: {
      config: { ...DEFAULT_CONFIG, environment: { defaultDistro } },
      sources: {},
      warnings: [],
    },
  })
  return {
    getValue: () => defaultDistro,
    config: {
      resolve,
      updateGlobal(patch) {
        const parsed = teskraConfigLayerSchema.safeParse(patch)
        if (!parsed.success) {
          return {
            ok: false,
            error: { code: 'VALIDATION_FAILED', message: 'invalid', retryable: false },
          }
        }
        if (parsed.data.environment?.defaultDistro !== undefined) {
          defaultDistro = parsed.data.environment.defaultDistro
        }
        return resolve()
      },
    },
  }
}

describe('WSL output parsing (TASK-011)', () => {
  it('cleans BOM/NUL artifacts and parses the UTF-16LE distro list shape', () => {
    const decodedWithArtifacts =
      '\uFEFFU\u0000b\u0000u\u0000n\u0000t\u0000u\u0000\r\nDebian\r\nUbuntu\r\n'
    expect(cleanWslOutput(decodedWithArtifacts)).not.toContain('\u0000')
    expect(parseWslDistributionNames(decodedWithArtifacts)).toEqual(['Ubuntu', 'Debian'])
  })

  it('parses WSL version and localized default-distribution labels', () => {
    expect(parseWslVersion('WSL version: 2.4.11.0\r\nKernel version: 6.6.87.2')).toBe('2.4.11.0')
    expect(parseWslDefaultDistribution('Default Distribution: Ubuntu-24.04')).toBe('Ubuntu-24.04')
    expect(parseWslDefaultDistribution('默认发行版：Debian')).toBe('Debian')
  })
})

describe('WslManager (TASK-011)', () => {
  it('lists distros, recognizes the host default, and detects --cd support', async () => {
    const commands = fakeCommands()
    const preferences = fakeConfig()
    const manager = createWslManager({ commands: commands.runner, config: preferences.config })

    const result = await manager.inspect()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toMatchObject({
      version: '2.4.11.0',
      supportsCd: true,
      systemDefault: 'Ubuntu-24.04',
      effectiveDefault: 'Ubuntu-24.04',
    })
    expect(result.data.distributions).toEqual([
      { name: 'Ubuntu-24.04', isSystemDefault: true, isConfiguredDefault: false },
      { name: 'Debian', isSystemDefault: false, isConfiguredDefault: false },
    ])
    expect(commands.requests).toHaveLength(3)
    for (const request of commands.requests) {
      expect(request.command).toBe('wsl.exe')
      expect(request.timeoutMs).toBeGreaterThan(0)
      expect(request.encoding).toBe('utf16le')
    }
  })

  it('uses the configured distro as the effective default and exposes runtime info', async () => {
    const commands = fakeCommands()
    const preferences = fakeConfig('debian')
    const manager = createWslManager({ commands: commands.runner, config: preferences.config })

    const environment = await manager.inspect()
    expect(environment.ok && environment.data.configuredDefault).toBe('debian')
    expect(environment.ok && environment.data.effectiveDefault).toBe('Debian')
    const runtime = await manager.getRuntimeInfo()
    expect(runtime).toEqual({
      ok: true,
      data: {
        available: true,
        version: '2.4.11.0',
        defaultDistro: 'Debian',
        distributions: ['Ubuntu-24.04', 'Debian'],
      },
    })
  })

  it('writes and clears the global default preference using canonical distro casing', async () => {
    const commands = fakeCommands()
    const preferences = fakeConfig()
    const manager = createWslManager({ commands: commands.runner, config: preferences.config })

    expect(await manager.setDefaultDistribution('debian')).toEqual({ ok: true, data: 'Debian' })
    expect(preferences.getValue()).toBe('Debian')
    expect(await manager.setDefaultDistribution(null)).toEqual({ ok: true, data: null })
    expect(preferences.getValue()).toBeNull()
  })

  it('returns an explicit structured error for a distro that is not installed', async () => {
    const commands = fakeCommands()
    const preferences = fakeConfig()
    const manager = createWslManager({ commands: commands.runner, config: preferences.config })

    const result = await manager.setDefaultDistribution('Arch')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toEqual({
        code: 'WSL_DISTRO_NOT_FOUND',
        message: 'WSL distribution "Arch" is not installed.',
        retryable: false,
      })
      expect(result.error).not.toHaveProperty('detail')
    }
  })

  it('returns WSL_NOT_AVAILABLE when wsl.exe cannot be started', async () => {
    const runner: CommandRunner = {
      async run() {
        return {
          ok: false,
          error: { code: 'UNKNOWN', message: 'spawn failed', retryable: false },
        }
      },
    }
    const manager = createWslManager({ commands: runner, config: fakeConfig().config })

    const result = await manager.inspect()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('WSL_NOT_AVAILABLE')
  })

  it('falls back safely when legacy inbox WSL has no --version command', async () => {
    const commands = fakeCommands({ version: success('Unknown option: --version', 1) })
    const manager = createWslManager({ commands: commands.runner, config: fakeConfig().config })

    const result = await manager.inspect()
    expect(result.ok && result.data.version).toBeUndefined()
    expect(result.ok && result.data.supportsCd).toBe(false)
  })
})
