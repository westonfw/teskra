import type { IpcResult, WslDistribution, WslEnvironment } from '@teskra/contracts'

import type { ConfigService } from '../config/config-service'
import { type InternalAppError, toPublicError } from '../errors'
import type { CommandResult, CommandRunner } from '../process/command-runner'
import { supportsCdFlag, type WslEnvironmentInfo } from './runtime'

/**
 * WSL detection and distro preferences (TASK-011).
 *
 * Every probe goes through CommandRunner. In particular, output is requested
 * as UTF-16LE because redirected `wsl.exe` output uses Windows Unicode text.
 * The manager is deliberately Electron-free so it can be mounted on the
 * system Facade by TASK-081 and tested in plain Node.
 */

const WSL_COMMAND = 'wsl.exe'
const PROBE_TIMEOUT_MS = 10_000

export interface WslManager {
  inspect(): Promise<IpcResult<WslEnvironment>>
  listDistributions(): Promise<IpcResult<readonly WslDistribution[]>>
  getDefaultDistribution(): Promise<IpcResult<string | null>>
  setDefaultDistribution(name: string | null): Promise<IpcResult<string | null>>
  /** Adapter payload consumed by WorkspaceRuntime without either side probing. */
  getRuntimeInfo(): Promise<IpcResult<WslEnvironmentInfo>>
}

export interface WslManagerDeps {
  readonly commands: CommandRunner
  readonly config: Pick<ConfigService, 'resolve' | 'updateGlobal'>
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

/** Removes BOM/NUL artifacts before any localized text parsing. */
export function cleanWslOutput(value: string): string {
  return value.replaceAll('\u0000', '').replace(/^\uFEFF/u, '')
}

export function parseWslDistributionNames(output: string): string[] {
  const seen = new Set<string>()
  const distributions: string[] = []
  for (const line of cleanWslOutput(output).split(/\r?\n/u)) {
    const name = line.trim().replace(/^\*\s*/u, '')
    const key = name.toLocaleLowerCase()
    if (name.length > 0 && !seen.has(key)) {
      seen.add(key)
      distributions.push(name)
    }
  }
  return distributions
}

/** `wsl --version` puts the WSL package version on its first versioned line. */
export function parseWslVersion(output: string): string | undefined {
  return cleanWslOutput(output).match(/\b\d+\.\d+(?:\.\d+){0,2}\b/u)?.[0]
}

/** Supports the English and Simplified-Chinese Windows status labels. */
export function parseWslDefaultDistribution(output: string): string | undefined {
  for (const line of cleanWslOutput(output).split(/\r?\n/u)) {
    const english = line.match(/^\s*Default\s+Distribution\s*:\s*(.+?)\s*$/iu)
    if (english?.[1] !== undefined) {
      return english[1]
    }
    const chinese = line.match(/^\s*默认(?:发行版|分发)?\s*[：:]\s*(.+?)\s*$/u)
    if (chinese?.[1] !== undefined) {
      return chinese[1]
    }
  }
  return undefined
}

function findCanonicalName(
  names: readonly string[],
  candidate: string | undefined,
): string | undefined {
  if (candidate === undefined) {
    return undefined
  }
  const folded = candidate.toLocaleLowerCase()
  return names.find((name) => name.toLocaleLowerCase() === folded)
}

function unavailable<T>(message: string, detail: string, cause?: unknown): IpcResult<T> {
  return fail({ code: 'WSL_NOT_AVAILABLE', message, retryable: true, detail, cause })
}

function probe(commands: CommandRunner, args: readonly string[]) {
  return commands.run({
    command: WSL_COMMAND,
    args,
    timeoutMs: PROBE_TIMEOUT_MS,
    encoding: 'utf16le',
  })
}

function commandText(result: IpcResult<CommandResult>): string {
  return result.ok ? `${result.data.stdout}\n${result.data.stderr}` : ''
}

export function createWslManager(deps: WslManagerDeps): WslManager {
  const inspect = async (): Promise<IpcResult<WslEnvironment>> => {
    const [statusResult, listResult, versionResult] = await Promise.all([
      probe(deps.commands, ['--status']),
      probe(deps.commands, ['--list', '--quiet']),
      probe(deps.commands, ['--version']),
    ])

    if (!statusResult.ok && !listResult.ok && !versionResult.ok) {
      return unavailable(
        'WSL is not available on this machine.',
        'wsl.exe probes could not be started',
        listResult.error,
      )
    }
    if (!listResult.ok) {
      return unavailable(
        'Unable to list WSL distributions.',
        'wsl.exe --list --quiet failed to start',
        listResult.error,
      )
    }
    if (listResult.data.exitCode !== 0) {
      return unavailable(
        'Unable to list WSL distributions.',
        `wsl.exe --list --quiet exited ${String(listResult.data.exitCode)}: ${listResult.data.stderr}`,
      )
    }

    const names = parseWslDistributionNames(listResult.data.stdout)
    const detectedDefault = parseWslDefaultDistribution(commandText(statusResult))
    const systemDefault = findCanonicalName(names, detectedDefault)
    const resolvedConfig = deps.config.resolve()
    if (!resolvedConfig.ok) {
      return resolvedConfig
    }
    const configuredCandidate = resolvedConfig.data.config.environment.defaultDistro ?? undefined
    const configuredMatch = findCanonicalName(names, configuredCandidate)
    const effectiveDefault = configuredMatch ?? systemDefault
    const version =
      versionResult.ok && versionResult.data.exitCode === 0
        ? parseWslVersion(commandText(versionResult))
        : undefined

    const distributions = names.map((name) => ({
      name,
      isSystemDefault: name === systemDefault,
      isConfiguredDefault: name === configuredMatch,
    }))
    return {
      ok: true,
      data: {
        ...(version !== undefined ? { version } : {}),
        supportsCd: supportsCdFlag(version),
        distributions,
        ...(systemDefault !== undefined ? { systemDefault } : {}),
        ...(configuredCandidate !== undefined ? { configuredDefault: configuredCandidate } : {}),
        ...(effectiveDefault !== undefined ? { effectiveDefault } : {}),
      },
    }
  }

  const manager: WslManager = {
    inspect,

    async listDistributions() {
      const result = await inspect()
      return result.ok ? { ok: true, data: result.data.distributions } : result
    },

    async getDefaultDistribution() {
      const result = await inspect()
      return result.ok ? { ok: true, data: result.data.effectiveDefault ?? null } : result
    },

    async setDefaultDistribution(name) {
      let canonical: string | null = null
      if (name !== null) {
        const trimmed = name.trim()
        if (trimmed.length === 0) {
          return fail({
            code: 'VALIDATION_FAILED',
            message: 'The WSL distribution name cannot be empty.',
            retryable: false,
            detail: 'setDefaultDistribution received an empty name',
          })
        }
        const environment = await inspect()
        if (!environment.ok) {
          return environment
        }
        canonical =
          findCanonicalName(
            environment.data.distributions.map((distribution) => distribution.name),
            trimmed,
          ) ?? null
        if (canonical === null) {
          return fail({
            code: 'WSL_DISTRO_NOT_FOUND',
            message: `WSL distribution "${trimmed}" is not installed.`,
            retryable: false,
            detail: `installed distributions: ${environment.data.distributions.map((item) => item.name).join(', ')}`,
          })
        }
      }

      const updated = deps.config.updateGlobal({ environment: { defaultDistro: canonical } })
      if (!updated.ok) {
        return updated
      }
      return { ok: true, data: updated.data.config.environment.defaultDistro }
    },

    async getRuntimeInfo() {
      const result = await inspect()
      if (!result.ok) {
        return result
      }
      return {
        ok: true,
        data: {
          available: true,
          ...(result.data.version !== undefined ? { version: result.data.version } : {}),
          ...(result.data.effectiveDefault !== undefined
            ? { defaultDistro: result.data.effectiveDefault }
            : {}),
          distributions: result.data.distributions.map((distribution) => distribution.name),
        },
      }
    },
  }

  return manager
}
