import type {
  AgentDefinition,
  AgentDetectionResult,
  AgentStartRequest,
  IpcResult,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'

export interface AgentProcessHandle {
  readonly runId: string
  readonly processId: string
  readonly pid: number
  readonly startedAt: string
}

export interface AgentAdapterDetectionRequest {
  readonly runtime: WorkspaceRuntimeRef
  readonly refresh?: boolean
}

/** TASK-025: the sole contract AgentManager uses for provider-specific CLIs. */
export interface CodingAgentAdapter {
  readonly definition: AgentDefinition
  detect(request: AgentAdapterDetectionRequest): Promise<IpcResult<AgentDetectionResult>>
  start(request: AgentStartRequest): Promise<IpcResult<AgentProcessHandle>>
  send(runId: string, input: string): Promise<IpcResult<void>>
  cancel(runId: string): Promise<IpcResult<void>>
  resume?(request: AgentStartRequest): Promise<IpcResult<AgentProcessHandle>>
}
