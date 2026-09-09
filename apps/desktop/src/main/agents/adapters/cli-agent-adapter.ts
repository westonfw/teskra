import type {
  AgentDefinition,
  AgentResumeRequest,
  AgentStartRequest,
  IpcResult,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'

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
}

export interface CliAgentAdapterOptions {
  readonly definition: AgentDefinition
  readonly processes: Pick<ProcessManager, 'start' | 'write' | 'stop'>
  readonly detector: Pick<AgentDetector, 'detect' | 'getExecutableOverride'>
  readonly resolveRuntime: (ref: WorkspaceRuntimeRef) => IpcResult<WorkspaceRuntime>
  readonly baseArgs?: readonly string[]
  readonly buildLaunch: (request: AgentStartRequest) => CliAgentLaunch
  readonly buildResumeLaunch?: (request: AgentResumeRequest) => CliAgentLaunch
}

export function agentProcessId(runId: string): string {
  return `agent-run:${runId}`
}

function processEnvironment(
  request: AgentStartRequest,
  launch: CliAgentLaunch,
): Readonly<Record<string, string>> {
  return {
    ...request.workspace.env,
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
