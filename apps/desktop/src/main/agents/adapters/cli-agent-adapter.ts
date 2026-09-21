import type {
  AgentDefinition,
  AgentResumeRequest,
  AgentStartRequest,
  IpcResult,
  ProviderSessionRef,
  WorkspaceEnvValue,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'
import { isWorkspaceSecretRef } from '@teskra/contracts'

import path from 'node:path'

import { getLogger } from '../../logger'
import {
  dropCaseShadowedKeys,
  type ProcessManager,
  type ProcessStartRequest,
} from '../../process/process-manager'
import {
  crossesWslBoundary,
  resolveRuntimePath,
  type WorkspaceRuntime,
} from '../../workspace/runtime'
import type { AgentDetector } from '../agent-detector'
import type {
  AgentAdapterDetectionRequest,
  AgentProcessHandle,
  CodingAgentAdapter,
} from './coding-agent-adapter'

export interface CliAgentLaunch {
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly providerSession?: ProviderSessionRef
}

export interface CliAgentAdapterOptions {
  readonly definition: AgentDefinition
  readonly processes: Pick<ProcessManager, 'start' | 'write' | 'resize' | 'stop'>
  readonly detector: Pick<AgentDetector, 'detect' | 'getExecutableOverride'>
  readonly resolveRuntime: (ref: WorkspaceRuntimeRef) => IpcResult<WorkspaceRuntime>
  readonly baseArgs?: readonly string[]
  readonly buildLaunch: (request: AgentStartRequest) => CliAgentLaunch
  readonly buildResumeLaunch?: (request: AgentResumeRequest) => CliAgentLaunch
}

export function agentProcessId(runId: string): string {
  return `agent-run:${runId}`
}

/**
 * The Run directory the Agent must be able to WRITE (handoff + artifacts,
 * ADR-0004): the dirname of the runtime-scoped handoff path. Agent CLIs
 * sandbox writes to the workdir by default, so without an explicit grant the
 * agent literally cannot write its handoff — observed on a real Codex run
 * where both apply_patch and direct writes were denied.
 */
export function agentHandoffDir(request: AgentStartRequest): string | undefined {
  if (request.handoffPath === undefined) {
    return undefined
  }
  return request.workspace.runtime.kind === 'windows'
    ? path.win32.dirname(request.handoffPath)
    : path.posix.dirname(request.handoffPath)
}

/**
 * TASK-088 backstop: the AgentManager resolves workspace env secret refs to
 * plaintext before launch, so only plain strings should arrive here. A ref
 * that still leaks through is dropped (never passed to the process as a
 * literal "{ secretRef }" value) and logged by key name only.
 */
function plainWorkspaceEnv(
  env: Readonly<Record<string, WorkspaceEnvValue>> | undefined,
  runId: string,
): Record<string, string> {
  const plain: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (isWorkspaceSecretRef(value)) {
      getLogger('agent').warn(
        { runId, key },
        'Unresolved secret env ref reached the Adapter; the variable was omitted.',
      )
      continue
    }
    plain[key] = value
  }
  return plain
}

function processEnvironment(
  request: AgentStartRequest,
  launch: CliAgentLaunch,
  runtime: WorkspaceRuntime,
): Readonly<Record<string, string>> {
  const base: Record<string, string> = {
    ...plainWorkspaceEnv(request.workspace.env, request.runId),
    ...request.environment,
    ...launch.env,
  }
  // Milestone 24 §13.1: the account-profile env occupies the launch slot —
  // after request.environment, before the system-owned TESKRA_* keys — so
  // the profile identity always wins over workspace/request env (§13.2).
  const profileEnv = request.profileEnvironment ?? {}
  const systemEnv: Record<string, string> = {
    ...(request.handoffPath !== undefined ? { TESKRA_HANDOFF_PATH: request.handoffPath } : {}),
    ...(request.artifactDir !== undefined ? { TESKRA_ARTIFACT_DIR: request.artifactDir } : {}),
    TESKRA_RUN_ID: request.runId,
  }
  // P0-1 (docs/code-review-2026-09-21.md §2): object spread only dedupes
  // exact-case keys. The env block is looked up case-insensitively (first
  // match wins) at two layers, so strip every base key that
  // case-insensitively collides with a profile/system key whenever either
  // layer is in play — the profile's and system's own casing is then the
  // only one present:
  //   1. Target-runtime semantics: a Windows runtime spawns a Windows
  //      process, whose env lookup is case-insensitive (`codex_home`
  //      inserted earlier survives next to `CODEX_HOME` and wins).
  //   2. wsl.exe relay semantics: on a Windows host a WSL runtime's env is
  //      first set on the wsl.exe WINDOWS process and only then forwarded
  //      into Linux by name via WSLENV — the wsl.exe layer resolves names
  //      case-insensitively too, so a smuggled `codex_home` can still shadow
  //      the profile's `CODEX_HOME` before WSLENV ever runs
  //      (crossesWslBoundary = wsl ref + non-hostNative, i.e. Windows host).
  // A WSL workspace on a Linux host is the native runtime (hostNative):
  // Linux env is case-sensitive, `teskra_run_id` and `TESKRA_RUN_ID` are two
  // distinct variables there, so base keys pass through untouched (the
  // exact-case system keys are still written last).
  const privileged = { ...profileEnv, ...systemEnv }
  const screened =
    runtime.ref.kind === 'windows' || crossesWslBoundary(runtime)
      ? dropCaseShadowedKeys(base, privileged)
      : base
  return {
    ...screened,
    ...profileEnv,
    ...systemEnv,
  }
}

/**
 * P0-1: handoff / artifact / permission-config paths are HOST-side (the run
 * directory lives in the host data root and the host collects from it), so a
 * WSL-on-Windows agent cannot use them verbatim — translate them into the
 * runtime's own path form (`C:\…` → `/mnt/c/…`) before building launch args
 * and the process environment (ADR-0004). Host-native runtimes pass through.
 */
function runtimeScopedPaths(
  runtime: WorkspaceRuntime,
  request: AgentStartRequest,
): AgentStartRequest {
  return {
    ...request,
    ...(request.handoffPath === undefined
      ? {}
      : { handoffPath: resolveRuntimePath(runtime, request.handoffPath) }),
    ...(request.artifactDir === undefined
      ? {}
      : { artifactDir: resolveRuntimePath(runtime, request.artifactDir) }),
    ...(request.permissionConfigPath === undefined
      ? {}
      : { permissionConfigPath: resolveRuntimePath(runtime, request.permissionConfigPath) }),
  }
}

/** Shared process plumbing; provider-specific argument construction stays in each Adapter. */
export function createCliAgentAdapter(options: CliAgentAdapterOptions): CodingAgentAdapter {
  const startProcess = async (
    request: AgentStartRequest,
    buildLaunch: (request: AgentStartRequest) => CliAgentLaunch,
  ): Promise<IpcResult<AgentProcessHandle>> => {
    const runtime = options.resolveRuntime(request.workspace.runtime)
    if (!runtime.ok) return runtime
    const override = options.detector.getExecutableOverride({
      agentId: options.definition.id,
      runtime: request.workspace.runtime,
    })
    if (!override.ok) return override

    // Launch with the full path detection resolved (e.g. the `codex.cmd`
    // where.exe line) instead of the bare command name — node-pty's
    // CreateProcess cannot resolve npm shims from PATH. Detection results
    // are cached (5 min TTL), so this adds at most one probe per TTL window;
    // any detection failure falls back to the previous behavior.
    const detected = await options.detector.detect({
      agentId: options.definition.id,
      runtime: request.workspace.runtime,
    })
    const command =
      detected.ok && detected.data.installed && detected.data.executable !== undefined
        ? detected.data.executable
        : (override.data ?? options.definition.executable.command)

    const scoped = runtimeScopedPaths(runtime.data, request)
    const launch = buildLaunch(scoped)
    const startRequest: ProcessStartRequest = {
      id: agentProcessId(request.runId),
      command,
      args: [
        ...(options.baseArgs ?? options.definition.executable.defaultArgs ?? []),
        ...launch.args,
      ],
      cwd: scoped.worktreePath ?? scoped.workspace.path,
      env: processEnvironment(scoped, launch, runtime.data),
      workspaceId: request.workspace.id,
      agentRunId: request.runId,
      runtime: runtime.data,
    }
    const started = options.processes.start(startRequest)
    if (!started.ok) return started
    return {
      ok: true,
      data: {
        runId: request.runId,
        processId: started.data.id,
        pid: started.data.pid,
        startedAt: started.data.startedAt,
        ...(launch.providerSession === undefined
          ? {}
          : { providerSession: launch.providerSession }),
      },
    }
  }

  const adapter: CodingAgentAdapter = {
    definition: options.definition,

    detect(request: AgentAdapterDetectionRequest) {
      return options.detector.detect({
        agentId: options.definition.id,
        runtime: request.runtime,
        refresh: request.refresh,
      })
    },

    start(request) {
      return startProcess(request, options.buildLaunch)
    },

    send(runId, input) {
      return Promise.resolve(options.processes.write(agentProcessId(runId), input))
    },

    resize(runId, cols, rows) {
      return options.processes.resize(agentProcessId(runId), cols, rows)
    },

    async cancel(runId) {
      const stopped = await options.processes.stop(agentProcessId(runId))
      return stopped.ok ? { ok: true, data: undefined } : stopped
    },
  }

  const buildResumeLaunch = options.buildResumeLaunch
  if (buildResumeLaunch !== undefined) {
    adapter.resume = (request) =>
      startProcess(request, (scoped) => ({
        ...buildResumeLaunch({ ...scoped, providerSession: request.providerSession }),
      }))
  }

  return adapter
}
