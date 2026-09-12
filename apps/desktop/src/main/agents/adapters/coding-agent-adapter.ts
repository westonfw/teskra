import type {
  AgentDefinition,
  AgentDetectionResult,
  AgentResumeRequest,
  AgentStartRequest,
  IpcResult,
  ProviderSessionRef,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'

export interface AgentProcessHandle {
  readonly runId: string
  readonly processId: string
  readonly pid: number
  readonly startedAt: string
  readonly providerSession?: ProviderSessionRef
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
  /** Best-effort PTY resize; adapters without a live PTY may omit it. */
  resize?(runId: string, cols: number, rows: number): IpcResult<void>
  cancel(runId: string): Promise<IpcResult<void>>
  resume?(request: AgentResumeRequest): Promise<IpcResult<AgentProcessHandle>>
}
