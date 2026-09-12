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

import { getLogger } from '../../logger'
import type { ProcessManager, ProcessStartRequest } from '../../process/process-manager'
import type { WorkspaceRuntime } from '../../workspace/runtime'
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
): Readonly<Record<string, string>> {
  return {
    ...plainWorkspaceEnv(request.workspace.env, request.runId),
    ...request.environment,
    ...launch.env,
    ...(request.handoffPath !== undefined ? { TESKRA_HANDOFF_PATH: request.handoffPath } : {}),
    ...(request.artifactDir !== undefined ? { TESKRA_ARTIFACT_DIR: request.artifactDir } : {}),
    TESKRA_RUN_ID: request.runId,
  }
}

/** Shared process plumbing; provider-specific argument construction stays in each Adapter. */
export function createCliAgentAdapter(options: CliAgentAdapterOptions): CodingAgentAdapter {
  const startProcess = async (
    request: AgentStartRequest,
    launch: CliAgentLaunch,
  ): Promise<IpcResult<AgentProcessHandle>> => {
    const runtime = options.resolveRuntime(request.workspace.runtime)
    if (!runtime.ok) return runtime
    const override = options.detector.getExecutableOverride({
      agentId: options.definition.id,
      runtime: request.workspace.runtime,
    })
    if (!override.ok) return override

    const startRequest: ProcessStartRequest = {
      id: agentProcessId(request.runId),
      command: override.data ?? options.definition.executable.command,
      args: [
        ...(options.baseArgs ?? options.definition.executable.defaultArgs ?? []),
        ...launch.args,
      ],
      cwd: request.worktreePath ?? request.workspace.path,
      env: processEnvironment(request, launch),
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

    async start(request) {
      return startProcess(request, options.buildLaunch(request))
    },

    async send(runId, input) {
      return options.processes.write(agentProcessId(runId), input)
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
    adapter.resume = async (request) => startProcess(request, buildResumeLaunch(request))
  }

  return adapter
}
