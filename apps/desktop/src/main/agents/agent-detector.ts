import type {
  AgentDefinition,
  AgentDetectionRequest,
  AgentDetectionResult,
  AgentExecutableOverrideRequest,
  IpcResult,
  ListAgentDetectionsRequest,
  SetAgentExecutableOverrideRequest,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'

import type { ConfigService } from '../config/config-service'
import { toPublicError } from '../errors'
import type { CommandRunner } from '../process/command-runner'
import { isWindowsCmdShim } from '../process/windows-shim'
import { resolveExecutableLookup, type WorkspaceRuntime } from '../workspace/runtime'
import type { AgentRegistry } from './agent-registry'

export interface AgentDetector {
  detect(request: AgentDetectionRequest): Promise<IpcResult<AgentDetectionResult>>
  list(request: ListAgentDetectionsRequest): Promise<IpcResult<readonly AgentDetectionResult[]>>
  getExecutableOverride(request: AgentExecutableOverrideRequest): IpcResult<string | null>
  setExecutableOverride(request: SetAgentExecutableOverrideRequest): IpcResult<string | null>
  clearCache(): void
}

export interface AgentDetectorDeps {
  readonly registry: Pick<AgentRegistry, 'get' | 'list'>
  readonly commands: CommandRunner
  readonly config: Pick<ConfigService, 'resolve' | 'updateGlobal'>
  readonly resolveRuntime: (ref: WorkspaceRuntimeRef) => IpcResult<WorkspaceRuntime>
  readonly now?: () => number
  readonly cacheTtlMs?: number
}

interface CacheEntry {
  readonly expiresAt: number
  readonly result: AgentDetectionResult
}

const DETECTION_TIMEOUT_MS = 5_000
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000

function fail<T>(message: string, detail: string): IpcResult<T> {
  return {
    ok: false,
    error: toPublicError({
      code: 'VALIDATION_FAILED',
      message,
      retryable: false,
      detail,
    }),
  }
}

function overrideKey(agentId: string, runtime: WorkspaceRuntimeRef): string {
  return JSON.stringify([
    agentId,
    runtime.kind,
    runtime.distro ?? null,
    runtime.host ?? null,
    runtime.containerId ?? null,
  ])
}

function firstLine(output: string): string | undefined {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
}

/**
 * Picks the executable line from a lookup (`where.exe` / `which`) result.
 *
 * Windows: npm global installs emit THREE shims and `where.exe` lists the
 * extension-less bash script FIRST — a file CreateProcess cannot launch. So
 * instead of the first line, prefer a `.exe`, then a `.cmd`/`.bat` shim
 * (launched through cmd.exe downstream). Returns undefined when the output
 * holds only non-executable shims (extension-less / `.ps1`).
 *
 * POSIX (`which`): the first line stays authoritative.
 */
export function selectLookupExecutable(output: string, windows: boolean): string | undefined {
  if (!windows) {
    return firstLine(output)
  }
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.find((line) => /\.exe$/i.test(line)) ?? lines.find((line) => isWindowsCmdShim(line))
}

export function createAgentDetector(deps: AgentDetectorDeps): AgentDetector {
  const now = deps.now ?? Date.now
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const cache = new Map<string, CacheEntry>()

  const definition = (agentId: string): IpcResult<AgentDefinition> => {
    const found = deps.registry.get(agentId)
    return found === undefined
      ? fail(`Unknown Agent "${agentId}".`, `Agent Registry does not contain id=${agentId}`)
      : { ok: true, data: found }
  }

  const getExecutableOverride = (
    request: AgentExecutableOverrideRequest,
  ): IpcResult<string | null> => {
    const found = definition(request.agentId)
    if (!found.ok) return found
    const resolved = deps.config.resolve()
    if (!resolved.ok) return resolved
    return {
      ok: true,
      data:
        resolved.data.config.agents.executableOverrides[
          overrideKey(request.agentId, request.runtime)
        ] ?? null,
    }
  }

  const detector: AgentDetector = {
    async detect(request) {
      const found = definition(request.agentId)
      if (!found.ok) return found
      const key = overrideKey(request.agentId, request.runtime)
      const currentTime = now()
      const cached = cache.get(key)
      if (request.refresh !== true && cached !== undefined && cached.expiresAt > currentTime) {
        return { ok: true, data: { ...cached.result, fromCache: true } }
      }

      const override = getExecutableOverride(request)
      if (!override.ok) return override
      const runtime = deps.resolveRuntime(request.runtime)
      if (!runtime.ok) return runtime
      const runtimeStatus = runtime.data.validate()
      if (!runtimeStatus.ok) return runtimeStatus

      const base = {
        agentId: request.agentId,
        runtime: request.runtime,
        overridden: override.data !== null,
        fromCache: false,
        checkedAt: new Date(currentTime).toISOString(),
      }

      let executable = override.data ?? undefined
      if (executable === undefined) {
        const lookup = resolveExecutableLookup(runtime.data, found.data.executable.command)
        const located = await deps.commands.run({
          command: lookup.executable,
          args: lookup.args,
          cwd: lookup.cwd,
          timeoutMs: DETECTION_TIMEOUT_MS,
        })
        if (!located.ok || located.data.exitCode !== 0) {
          const result: AgentDetectionResult = {
            ...base,
            installed: false,
            error: located.ok
              ? `${found.data.name} was not found in this runtime.`
              : located.error.message,
          }
          cache.set(key, { result, expiresAt: currentTime + cacheTtlMs })
          return { ok: true, data: result }
        }
        const windows = runtime.data.ref.kind === 'windows'
        executable = selectLookupExecutable(located.data.stdout, windows)
        if (executable === undefined) {
          const onlyShims = windows && firstLine(located.data.stdout) !== undefined
          const result: AgentDetectionResult = {
            ...base,
            installed: false,
            error: onlyShims
              ? `${found.data.name} lookup only found shims Windows cannot execute (no .exe/.cmd/.bat); set an executable override.`
              : `${found.data.name} lookup returned no executable path.`,
          }
          cache.set(key, { result, expiresAt: currentTime + cacheTtlMs })
          return { ok: true, data: result }
        }
      }

      const version = await deps.commands.run({
        command: executable,
        args: [...(found.data.executable.defaultArgs ?? []), ...found.data.detection.versionArgs],
        timeoutMs: DETECTION_TIMEOUT_MS,
        runtime: runtime.data,
      })
      const versionText = version.ok
        ? (firstLine(version.data.stdout) ?? firstLine(version.data.stderr))
        : undefined
      const result: AgentDetectionResult = {
        ...base,
        installed: version.ok && version.data.exitCode === 0,
        executable,
        ...(versionText !== undefined ? { version: versionText } : {}),
        ...(!version.ok
          ? { error: version.error.message }
          : version.data.exitCode !== 0
            ? {
                error: `${found.data.name} version check exited with code ${String(version.data.exitCode)}.`,
              }
            : {}),
      }
      cache.set(key, { result, expiresAt: currentTime + cacheTtlMs })
      return { ok: true, data: result }
    },

    async list(request) {
      const results = await Promise.all(
        deps.registry.list().map((agent) =>
          detector.detect({
            agentId: agent.id,
            runtime: request.runtime,
            refresh: request.refresh,
          }),
        ),
      )
      const failed = results.find((result) => !result.ok)
      if (failed !== undefined && !failed.ok) return failed
      return {
        ok: true,
        data: results.flatMap((result) => (result.ok ? [result.data] : [])),
      }
    },

    getExecutableOverride,

    setExecutableOverride(request) {
      const found = definition(request.agentId)
      if (!found.ok) return found
      const key = overrideKey(request.agentId, request.runtime)
      const updated = deps.config.updateGlobal({
        agents: { executableOverrides: { [key]: request.path } },
      })
      if (!updated.ok) return updated
      cache.delete(key)
      return { ok: true, data: request.path }
    },

    clearCache() {
      cache.clear()
    },
  }

  return detector
}
