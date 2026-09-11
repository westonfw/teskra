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
  BuildContextRequest,
  BuiltContext,
  CreateCriteriaSetRequest,
  CreateTaskRequest,
  CreateTerminalRequest,
  CreateWorkspaceRequest,
  CriteriaSetIdRequest,
  CriterionIdRequest,
  CriterionScoreRecord,
  CreatePermissionRuleRequest,
  CreateMemoryRequest,
  CredentialStoreStatus,
  DeleteCredentialRequest,
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
  ListRecoveryIssuesRequest,
  ListRecentWorkspacesRequest,
  ListAgentDetectionsRequest,
  ListAgentRunsRequest,
  ListArtifactsRequest,
  ListCriteriaSetsRequest,
  ListCriterionScoresRequest,
  ListMemoriesRequest,
  ListPermissionAuditRequest,
  ListPermissionRulesRequest,
  ListPromptTemplatesRequest,
  ListReviewFindingsRequest,
  ListReviewPanelsRequest,
  ListTasksRequest,
  ListTerminalsRequest,
  ListWorkflowDefinitionsRequest,
  ListWorkflowRunsRequest,
  LoadWorkflowDefinitionRequest,
  Memory,
  MemoryIdRequest,
  MergePreflightResult,
  OpenWorkspaceRequest,
  OpenSystemDirectoryRequest,
  PermissionAuditEntry,
  PermissionDecisionResult,
  PermissionRule,
  PermissionRuleIdRequest,
  PromptTemplateInfo,
  RecordArtifactRequest,
  RecoveryReport,
  RenderedPrompt,
  RenderPromptTemplateRequest,
  ResolveConfigRequest,
  ResolvePermissionDecisionRequest,
  ResolvePermissionProfileRequest,
  ResolvedConfig,
  ResolvedPermissionProfile,
  ResumeAgentRunRequest,
  RetentionPlan,
  RetentionPlanRequest,
  RetentionReport,
  RetentionRunRequest,
  ReviewFindingRecord,
  ReviewPanel,
  ReviewPanelIdRequest,
  ReviewPanelResult,
  ReviewRunStartResult,
  RunDoctorRequest,
  ScanRunArtifactsRequest,
  SelectWorkspaceDirectoryRequest,
  SendAgentRunInputRequest,
  SetAgentExecutableOverrideRequest,
  SetCredentialRequest,
  StartFullWorkflowRequest,
  StartReviewPanelRequest,
  FullWorkflowRunSummary,
  FullWorkflowStartResult,
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
  UpdateMemoryRequest,
  UpdatePermissionRuleRequest,
  UpdateTaskRequest,
  Workspace,
  WorkspaceIdRequest,
  WorkspaceValidationResult,
  WorkflowDefinition,
  WorkflowDefinitionFileInfo,
  WorkflowDispatchRequest,
  WorkflowDispatchResult,
  WorkflowIterateRequest,
  WorkflowIterateResult,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunIdRequest,
  WorkflowRunStartRequest,
  WorkflowStep,
  WorkflowStepResolveRequest,
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

/** TASK-070: read-only aggregation of the five recoverable problem categories. */
export interface RecoveryPort {
  list(request?: ListRecoveryIssuesRequest): Promise<IpcResult<RecoveryReport>>
}

export interface SettingsPort {
  resolveConfig(request?: ResolveConfigRequest): IpcResult<ResolvedConfig>
  updateConfig(request: UpdateConfigRequest): IpcResult<ResolvedConfig>
  openDirectory(request: OpenSystemDirectoryRequest): Promise<IpcResult<void>>
}

/**
 * TASK-088: credential set/delete/list plus availability. There is no `get` —
 * plaintext values never cross into the Renderer; `list` returns key names.
 */
export interface CredentialPort {
  status(): IpcResult<CredentialStoreStatus>
  set(request: SetCredentialRequest): IpcResult<void>
  delete(request: DeleteCredentialRequest): IpcResult<boolean>
  list(): IpcResult<readonly string[]>
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

/**
 * TASK-067: Workspace Memory CRUD (plan §45/§46). Repo-local memories from
 * `<repo>/.teskra/memory/` appear in `list` as read-only `file:` records;
 * mutating them returns VALIDATION_FAILED.
 */
export interface MemoryPort {
  list(request: ListMemoriesRequest): IpcResult<readonly Memory[]>
  get(request: MemoryIdRequest): IpcResult<Memory | null>
  create(request: CreateMemoryRequest): IpcResult<Memory>
  update(request: UpdateMemoryRequest): IpcResult<Memory | null>
  delete(request: MemoryIdRequest): IpcResult<boolean>
}

/**
 * TASK-068: ContextBuilder (plan §47). `preview` returns the packed,
 * budget-limited context (with `omittedCount` for dropped sections) so the
 * UI can show exactly what an Agent would receive before a Run starts.
 */
export interface ContextPort {
  preview(request: BuildContextRequest): IpcResult<BuiltContext>
}

/**
 * TASK-065 (ADR-0002): rule CRUD, layered profile resolution (with `ask`
 * downgrade notices), approval decisions, and the post-hoc audit trail.
 */
export interface PermissionPort {
  listRules(request?: ListPermissionRulesRequest): IpcResult<readonly PermissionRule[]>
  createRule(request: CreatePermissionRuleRequest): IpcResult<PermissionRule>
  updateRule(request: UpdatePermissionRuleRequest): IpcResult<PermissionRule | null>
  deleteRule(request: PermissionRuleIdRequest): IpcResult<boolean>
  listAudit(request?: ListPermissionAuditRequest): IpcResult<readonly PermissionAuditEntry[]>
  resolveProfile(request: ResolvePermissionProfileRequest): IpcResult<ResolvedPermissionProfile>
  resolveDecision(request: ResolvePermissionDecisionRequest): IpcResult<PermissionDecisionResult>
}

/** TASK-053/054: read access to persisted review findings and criterion scores;
 *  TASK-060: Review Panel orchestration (start + panel queries). */
export interface ReviewPort {
  listFindings(request: ListReviewFindingsRequest): IpcResult<readonly ReviewFindingRecord[]>
  listCriterionScores(
    request: ListCriterionScoresRequest,
  ): IpcResult<readonly CriterionScoreRecord[]>
  startPanel(request: StartReviewPanelRequest): Promise<IpcResult<ReviewPanelResult>>
  getPanel(request: ReviewPanelIdRequest): IpcResult<ReviewPanelResult | null>
  listPanels(request: ListReviewPanelsRequest): IpcResult<readonly ReviewPanel[]>
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

/**
 * TASK-069: RetentionService GC. planRetention is the dry-run preview;
 * runRetention executes (cancellable between items via cancelRetention) and
 * returns the per-item audit trail.
 */
export interface MaintenancePort {
  planRetention(request?: RetentionPlanRequest): Promise<IpcResult<RetentionPlan>>
  runRetention(request?: RetentionRunRequest): Promise<IpcResult<RetentionReport>>
  cancelRetention(): IpcResult<boolean>
}

/** TASK-055/056: repo-local definitions (ADR-0005) + WorkflowRun persistence;
 *  TASK-059: engine control (start/cancel/resolveStep) + Dispatch Primitive. */
export interface WorkflowPort {
  listDefinitions(
    request: ListWorkflowDefinitionsRequest,
  ): IpcResult<readonly WorkflowDefinitionFileInfo[]>
  loadDefinition(request: LoadWorkflowDefinitionRequest): IpcResult<WorkflowDefinition>
  listRuns(request?: ListWorkflowRunsRequest): IpcResult<readonly WorkflowRun[]>
  getRun(request: WorkflowRunIdRequest): IpcResult<WorkflowRunDetail | null>
  startRun(request: WorkflowRunStartRequest): Promise<IpcResult<WorkflowRunDetail>>
  cancelRun(request: WorkflowRunIdRequest): Promise<IpcResult<WorkflowRun>>
  resolveStep(request: WorkflowStepResolveRequest): IpcResult<WorkflowStep>
  dispatch(request: WorkflowDispatchRequest): Promise<IpcResult<WorkflowDispatchResult>>
  /** TASK-062 Iterate Primitive: Implement → Review → Fix → Review with safety caps. */
  iterate(request: WorkflowIterateRequest): Promise<IpcResult<WorkflowIterateResult>>
  /**
   * TASK-063 Default Full Workflow: one-click Task launch (criteria → worktree
   * → implement → test → review → gate, FAIL loop under the iteration caps).
   * `runSummary` is the completion view: steps + worktree diff + criteria result.
   */
  startFullWorkflow(request: StartFullWorkflowRequest): Promise<IpcResult<FullWorkflowStartResult>>
  runSummary(request: WorkflowRunIdRequest): Promise<IpcResult<FullWorkflowRunSummary>>
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
  readonly credential: CredentialPort
  readonly prompts: PromptPort
  /** Main-process event source consumed only by RendererEventBridge. */
  readonly events: RuntimeEventSource
  readonly task: TaskPort
  readonly criteria: CriteriaPort
  readonly artifact: ArtifactPort
  readonly handoff: HandoffPort
  readonly memory: MemoryPort
  readonly context: ContextPort
  readonly permission: PermissionPort
  readonly review: ReviewPort
  readonly agent: AgentCatalogPort
  readonly git: GitPort
  readonly worktree: WorktreePort
  readonly maintenance: MaintenancePort
  readonly workflow: WorkflowPort
  readonly recovery: RecoveryPort
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
