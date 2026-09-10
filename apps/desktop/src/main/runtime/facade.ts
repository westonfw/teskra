import type {
  AcceptanceCriteriaSet,
  AcceptanceCriteriaSetDetail,
  AcceptanceCriterion,
  AddCriterionRequest,
  AgentDefinition,
  AgentDetectionRequest,
  AgentDetectionResult,
  AgentRun,
  AgentRunIdRequest,
  AgentHealth,
  AgentExecutableOverrideRequest,
  ArchiveTaskRequest,
  Artifact,
  ArtifactContent,
  ArtifactIdRequest,
  BindRunCriteriaRequest,
  CreateCriteriaSetRequest,
  CreateTaskRequest,
  CreateTerminalRequest,
  CreateWorkspaceRequest,
  CriteriaSetIdRequest,
  CriterionIdRequest,
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
  HandoffRecord,
  IpcResult,
  ListRecentWorkspacesRequest,
  ListAgentDetectionsRequest,
  ListAgentRunsRequest,
  ListArtifactsRequest,
  ListCriteriaSetsRequest,
  ListPromptTemplatesRequest,
  ListReviewFindingsRequest,
  ListTasksRequest,
  ListTerminalsRequest,
  MergePreflightResult,
  OpenWorkspaceRequest,
  OpenSystemDirectoryRequest,
  PromptTemplateInfo,
  RecordArtifactRequest,
  RenderedPrompt,
  RenderPromptTemplateRequest,
  ResolveConfigRequest,
  ResumeAgentRunRequest,
  ReviewFindingRecord,
  ReviewRunStartResult,
  RunDoctorRequest,
  ResolvedConfig,
  ScanRunArtifactsRequest,
  SelectWorkspaceDirectoryRequest,
  SendAgentRunInputRequest,
  SetAgentExecutableOverrideRequest,
  SystemHealth,
  SystemInfo,
  SystemPaths,
  StartAgentRunRequest,
  StartReviewRunRequest,
  Task,
  TaskIdRequest,
  TerminalCloseRequest,
  TerminalIdRequest,
  TerminalResizeRequest,
  TerminalSession,
  TerminalWriteRequest,
  UpdateConfigRequest,
  UpdateCriterionRequest,
  UpdateTaskRequest,
  Workspace,
  WorkspaceIdRequest,
  WorkspaceValidationResult,
  Worktree,
  WorktreeCleanupRequest,
  WorktreeCleanupResult,
  WorktreeCreateRequest,
  WorktreeDiscardRequest,
  WorktreeIdRequest,
  WorktreeListRequest,
  WorktreeMergeRequest,
  WorktreeMergeResult,
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

/** TASK-079: externalized prompt templates (built-in + repo-local overrides). */
export interface PromptPort {
  list(request?: ListPromptTemplatesRequest): IpcResult<readonly PromptTemplateInfo[]>
  render(request: RenderPromptTemplateRequest): IpcResult<RenderedPrompt>
}

export interface TaskPort {
  create(request: CreateTaskRequest): IpcResult<Task>
  update(request: UpdateTaskRequest): IpcResult<Task>
  archive(request: ArchiveTaskRequest): IpcResult<Task>
  delete(request: TaskIdRequest): IpcResult<boolean>
  get(request: TaskIdRequest): IpcResult<Task | null>
  list(request: ListTasksRequest): IpcResult<readonly Task[]>
}

export interface CriteriaPort {
  listSets(request: ListCriteriaSetsRequest): IpcResult<readonly AcceptanceCriteriaSet[]>
  getSet(request: CriteriaSetIdRequest): IpcResult<AcceptanceCriteriaSetDetail | null>
  createSet(request: CreateCriteriaSetRequest): IpcResult<AcceptanceCriteriaSetDetail>
  addCriterion(request: AddCriterionRequest): IpcResult<AcceptanceCriterion>
  updateCriterion(request: UpdateCriterionRequest): IpcResult<AcceptanceCriterion>
  removeCriterion(request: CriterionIdRequest): IpcResult<boolean>
  confirmSet(request: CriteriaSetIdRequest): IpcResult<AcceptanceCriteriaSet>
  supersedeSet(request: CriteriaSetIdRequest): IpcResult<AcceptanceCriteriaSet>
  bindRun(request: BindRunCriteriaRequest): IpcResult<AgentRun>
}

export interface ArtifactPort {
  record(request: RecordArtifactRequest): IpcResult<Artifact>
  list(request: ListArtifactsRequest): IpcResult<readonly Artifact[]>
  get(request: ArtifactIdRequest): IpcResult<ArtifactContent | null>
  scanRun(request: ScanRunArtifactsRequest): IpcResult<readonly Artifact[]>
}

/** TASK-051: read access to collected WorkerHandoff rows (ADR-0004). */
export interface HandoffPort {
  get(request: AgentRunIdRequest): IpcResult<HandoffRecord | null>
}

/** TASK-053: read access to persisted review findings (ADR-0004). */
export interface ReviewPort {
  listFindings(request: ListReviewFindingsRequest): IpcResult<readonly ReviewFindingRecord[]>
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
  startReview(request: StartReviewRunRequest): Promise<IpcResult<ReviewRunStartResult>>
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
  merge(request: WorktreeMergeRequest): Promise<IpcResult<WorktreeMergeResult>>
  discard(request: WorktreeDiscardRequest): Promise<IpcResult<Worktree>>
  archive(request: WorktreeIdRequest): Promise<IpcResult<Worktree>>
  cleanup(request: WorktreeCleanupRequest): Promise<IpcResult<WorktreeCleanupResult>>
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
  readonly prompts: PromptPort
  /** Main-process event source consumed only by RendererEventBridge. */
  readonly events: RuntimeEventSource
  readonly task: TaskPort
  readonly criteria: CriteriaPort
  readonly artifact: ArtifactPort
  readonly handoff: HandoffPort
  readonly review: ReviewPort
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
