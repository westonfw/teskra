import type {
  AgentDefinition,
  AgentDetectionRequest,
  AgentDetectionResult,
  AgentRun,
  AgentRunIdRequest,
  AgentHealth,
  AgentExecutableOverrideRequest,
  ArchiveTaskRequest,
  CreateTaskRequest,
  CreateTerminalRequest,
  CreateWorkspaceRequest,
  DiffResult,
  DoctorReport,
  FutureRuntimePortName,
  GitBranch,
  GitCommit,
  GitCommitRequest,
  GitCommitResult,
  GitDiffRequest,
  GitLogRequest,
  GitOpenFileRequest,
  GitRawDiff,
  GitStatus,
  GitWorkspaceRequest,
  IpcResult,
  ListRecentWorkspacesRequest,
  ListAgentDetectionsRequest,
  ListAgentRunsRequest,
  ListTasksRequest,
  ListTerminalsRequest,
  MergePreflightResult,
  OpenWorkspaceRequest,
  OpenSystemDirectoryRequest,
  ResolveConfigRequest,
  ResumeAgentRunRequest,
  RunDoctorRequest,
  ResolvedConfig,
  SelectWorkspaceDirectoryRequest,
  SendAgentRunInputRequest,
  SetAgentExecutableOverrideRequest,
  SystemHealth,
  SystemInfo,
  SystemPaths,
  StartAgentRunRequest,
  Task,
  TaskIdRequest,
  TerminalCloseRequest,
  TerminalIdRequest,
  TerminalResizeRequest,
  TerminalSession,
  TerminalWriteRequest,
  UpdateConfigRequest,
  UpdateTaskRequest,
  Workspace,
  WorkspaceIdRequest,
  WorkspaceValidationResult,
  Worktree,
  WorktreeCreateRequest,
  WorktreeIdRequest,
  WorktreeListRequest,
  WslDistribution,
  WslEnvironment,
  WorkbenchEventName,
  WorkbenchEvents,
} from '@teskra/contracts'

export interface WorkspacePort {
  create(request: CreateWorkspaceRequest): IpcResult<Workspace>
  open(request: OpenWorkspaceRequest): IpcResult<Workspace>
  remove(request: WorkspaceIdRequest): IpcResult<boolean>
  listRecent(request?: ListRecentWorkspacesRequest): IpcResult<Workspace[]>
  validate(request: OpenWorkspaceRequest): IpcResult<WorkspaceValidationResult>
  selectDirectory(request: SelectWorkspaceDirectoryRequest): Promise<IpcResult<string | null>>
}

export interface TerminalPort {
  create(request: CreateTerminalRequest): IpcResult<TerminalSession>
  write(request: TerminalWriteRequest): IpcResult<void>
  resize(request: TerminalResizeRequest): IpcResult<void>
  close(request: TerminalCloseRequest): Promise<IpcResult<void>>
  get(request: TerminalIdRequest): IpcResult<TerminalSession | null>
  list(request?: ListTerminalsRequest): IpcResult<readonly TerminalSession[]>
}

export interface SystemPort {
  info(): IpcResult<SystemInfo>
  paths(): IpcResult<SystemPaths>
  health(): Promise<IpcResult<SystemHealth>>
  inspectWsl(): Promise<IpcResult<WslEnvironment>>
  listWslDistributions(): Promise<IpcResult<readonly WslDistribution[]>>
  getDefaultWslDistribution(): Promise<IpcResult<string | null>>
  setDefaultWslDistribution(name: string | null): Promise<IpcResult<string | null>>
  doctor(request?: RunDoctorRequest): Promise<IpcResult<DoctorReport>>
}

export interface SettingsPort {
  resolveConfig(request?: ResolveConfigRequest): IpcResult<ResolvedConfig>
  updateConfig(request: UpdateConfigRequest): IpcResult<ResolvedConfig>
  openDirectory(request: OpenSystemDirectoryRequest): Promise<IpcResult<void>>
}

export interface TaskPort {
  create(request: CreateTaskRequest): IpcResult<Task>
  update(request: UpdateTaskRequest): IpcResult<Task>
  archive(request: ArchiveTaskRequest): IpcResult<Task>
  delete(request: TaskIdRequest): IpcResult<boolean>
  get(request: TaskIdRequest): IpcResult<Task | null>
  list(request: ListTasksRequest): IpcResult<readonly Task[]>
}

export interface GitPort {
  status(request: GitWorkspaceRequest): Promise<IpcResult<GitStatus>>
  branch(request: GitWorkspaceRequest): Promise<IpcResult<GitBranch>>
  diff(request: GitDiffRequest): Promise<IpcResult<GitRawDiff>>
  log(request: GitLogRequest): Promise<IpcResult<readonly GitCommit[]>>
  commit(request: GitCommitRequest): Promise<IpcResult<GitCommitResult>>
  changes(request: GitWorkspaceRequest): Promise<IpcResult<DiffResult>>
  openFile(request: GitOpenFileRequest): Promise<IpcResult<void>>
}

export interface AgentCatalogPort {
  listDefinitions(): IpcResult<readonly AgentDefinition[]>
  detect(request: AgentDetectionRequest): Promise<IpcResult<AgentDetectionResult>>
  listDetections(
    request: ListAgentDetectionsRequest,
  ): Promise<IpcResult<readonly AgentDetectionResult[]>>
  checkHealth(request: AgentDetectionRequest): Promise<IpcResult<AgentHealth>>
  listHealth(request: ListAgentDetectionsRequest): Promise<IpcResult<readonly AgentHealth[]>>
  getExecutableOverride(request: AgentExecutableOverrideRequest): IpcResult<string | null>
  setExecutableOverride(request: SetAgentExecutableOverrideRequest): IpcResult<string | null>
  start(request: StartAgentRunRequest): Promise<IpcResult<AgentRun>>
  resume(request: ResumeAgentRunRequest): Promise<IpcResult<AgentRun>>
  send(request: SendAgentRunInputRequest): Promise<IpcResult<void>>
  cancel(request: AgentRunIdRequest): Promise<IpcResult<AgentRun>>
  get(request: AgentRunIdRequest): IpcResult<AgentRun | null>
  list(request?: ListAgentRunsRequest): IpcResult<readonly AgentRun[]>
  getOutput(request: AgentRunIdRequest): IpcResult<string>
}

export interface WorktreePort {
  create(request: WorktreeCreateRequest): Promise<IpcResult<Worktree>>
  list(request: WorktreeListRequest): Promise<IpcResult<readonly Worktree[]>>
  validate(request: WorktreeIdRequest): Promise<IpcResult<Worktree>>
  preflight(request: WorktreeIdRequest): Promise<IpcResult<MergePreflightResult>>
  remove(request: WorktreeIdRequest): Promise<IpcResult<Worktree>>
}

export type FutureRuntimePort = object

export interface RuntimeEventSource {
  subscribe<Name extends WorkbenchEventName>(
    name: Name,
    handler: (payload: WorkbenchEvents[Name]) => void,
  ): () => void
}

export interface TeskraRuntime {
  readonly workspace: WorkspacePort
  readonly terminal: TerminalPort
  readonly system: SystemPort
  readonly settings: SettingsPort
  /** Main-process event source consumed only by RendererEventBridge. */
  readonly events: RuntimeEventSource
  readonly task: TaskPort
  readonly agent: AgentCatalogPort
  readonly git: GitPort
  readonly worktree: WorktreePort
  readonly workflow?: FutureRuntimePort
  dispose(): IpcResult<void>
}

/** The Typed IPC router uses this instead of dereferencing an absent port. */
export function requireRuntimePort(
  runtime: TeskraRuntime,
  name: FutureRuntimePortName,
): IpcResult<FutureRuntimePort> {
  const port = runtime[name]
  return port === undefined
    ? {
        ok: false,
        error: {
          code: 'CAPABILITY_NOT_AVAILABLE',
          message: `Runtime capability "${name}" is not available yet.`,
          retryable: false,
        },
      }
    : { ok: true, data: port }
}
