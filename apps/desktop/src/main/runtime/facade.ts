import type {
  AcceptanceCriteriaSet,
  AcceptanceCriteriaSetDetail,
  AcceptanceCriterion,
  AccountLoginSession,
  AccountProfileIdRequest,
  AccountRateLimitStats,
  AdapterAgentInfo,
  AddCriterionRequest,
  AgentAccountProfile,
  AgentDefinition,
  AgentDetectionRequest,
  AgentDetectionResult,
  AgentExecutionProfile,
  AgentProgressRecord,
  AgentRun,
  AgentRunIdRequest,
  AgentRunOutputRequest,
  AgentHealth,
  AgentExecutableOverrideRequest,
  ArchiveTaskRequest,
  Artifact,
  ArtifactContent,
  ArtifactIdRequest,
  BindRunCriteriaRequest,
  BuildContextRequest,
  BuiltContext,
  BindProfileAliasRequest,
  CancelAccountLoginRequest,
  ContinueAgentRunRequest,
  CreateAccountProfileRequest,
  CreateCriteriaSetRequest,
  CreateExecutionProfileRequest,
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
  ExecutionProfileIdRequest,
  FutureRuntimePortName,
  GitBranch,
  GitCommit,
  GitCommitRequest,
  GitCommitResult,
  GitDiffRequest,
  GitFilePatchRequest,
  GitLogRequest,
  GitOpenFileRequest,
  GitRawDiff,
  GitStatus,
  GitWorkspaceRequest,
  HandoffRecord,
  IpcResult,
  ListAccountProfilesRequest,
  ListAdapterAgentsRequest,
  ListExecutionProfilesRequest,
  ListRateLimitStatsRequest,
  ListRecoveryIssuesRequest,
  ListRecentWorkspacesRequest,
  ListAgentDetectionsRequest,
  ListAgentProgressRequest,
  ListAgentRunsRequest,
  ListArtifactsRequest,
  ListCriteriaSetsRequest,
  ListCriterionScoresRequest,
  ListDecisionsRequest,
  ListMemoriesRequest,
  ListPermissionAuditRequest,
  ListPermissionRulesRequest,
  ListProfileAliasesRequest,
  ListPromptTemplatesRequest,
  ListReviewFindingsRequest,
  ListReviewPanelsRequest,
  ListTasksRequest,
  ListTerminalsRequest,
  ListPendingShellConfirmationsRequest,
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
  PendingShellConfirmation,
  PermissionRule,
  PermissionRuleIdRequest,
  PendingDecision,
  ProfileAlias,
  PromptTemplateInfo,
  RecordArtifactRequest,
  RecoveryReport,
  RemoveAccountProfileRequest,
  RenderedPrompt,
  RenderPromptTemplateRequest,
  ResizeAccountLoginRequest,
  ResolveConfigRequest,
  ResolveDecisionRequest,
  ResolvePermissionDecisionRequest,
  ResolvePermissionProfileRequest,
  ResolvedConfig,
  ResolvedPermissionProfile,
  ResumeAgentRunRequest,
  ResizeAgentRunRequest,
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
  SetDefaultAccountProfileRequest,
  SetDefaultExecutionProfileRequest,
  StartAccountLoginRequest,
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
  UpdateAccountProfileRequest,
  UpdateExecutionProfileRequest,
  UpdateCriterionRequest,
  UpdateMemoryRequest,
  UpdatePermissionRuleRequest,
  UpdateTaskRequest,
  UnbindProfileAliasRequest,
  UpdateWorkspaceTrustRequest,
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
  WorkflowShellConfirmationRequest,
  WorkflowStep,
  WorkflowStepResolveRequest,
  WriteAccountLoginRequest,
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

/**
 * Milestone 24 (TASK-100): account profile CRUD + per-agent default.
 * TASK-102 adds the status-detect probe and the §24.2 interactive login
 * session; the IPC layer mounts Zod-validated channels onto this port.
 */
export interface AccountPort {
  list(request?: ListAccountProfilesRequest): Promise<IpcResult<readonly AgentAccountProfile[]>>
  /**
   * §4.2: agentIds with a registered account profile adapter — the "new
   * account" entry points (wizard / external import) filter to these. Existing
   * profiles of an agent whose adapter was removed are unaffected.
   */
  listAdapterAgents(
    request?: ListAdapterAgentsRequest,
  ): Promise<IpcResult<readonly AdapterAgentInfo[]>>
  /**
   * Per-profile rate-limit history from Teskra's own failure classifications
   * (ADR-0010), trailing 7 days — never a live quota reading.
   */
  listRateLimitStats(
    request?: ListRateLimitStatsRequest,
  ): Promise<IpcResult<readonly AccountRateLimitStats[]>>
  get(request: AccountProfileIdRequest): Promise<IpcResult<AgentAccountProfile | null>>
  create(request: CreateAccountProfileRequest): Promise<IpcResult<AgentAccountProfile>>
  update(request: UpdateAccountProfileRequest): Promise<IpcResult<AgentAccountProfile>>
  remove(request: RemoveAccountProfileRequest): Promise<IpcResult<AgentAccountProfile>>
  /** Soft disable without touching the CLI home (same lifecycle as remove). */
  disable(request: AccountProfileIdRequest): Promise<IpcResult<AgentAccountProfile>>
  enable(request: AccountProfileIdRequest): Promise<IpcResult<AgentAccountProfile>>
  /** §24: probe through the account adapter and persist the resulting status. */
  detect(request: AccountProfileIdRequest): Promise<IpcResult<AgentAccountProfile>>
  setDefault(request: SetDefaultAccountProfileRequest): Promise<IpcResult<void>>
  getDefault(request: { agentId: string }): Promise<IpcResult<string | undefined>>
  /** §24.2: returns the session handle immediately — never waits on OAuth. */
  startLogin(request: StartAccountLoginRequest): Promise<IpcResult<AccountLoginSession>>
  writeLogin(request: WriteAccountLoginRequest): Promise<IpcResult<void>>
  resizeLogin(request: ResizeAccountLoginRequest): Promise<IpcResult<void>>
  cancelLogin(request: CancelAccountLoginRequest): Promise<IpcResult<void>>
  /**
   * TASK-111 (§28/§53.1): workflow profile alias bindings. bind validates
   * that profileId exists in the kind's table and belongs to agentId.
   */
  listAliases(request?: ListProfileAliasesRequest): Promise<IpcResult<readonly ProfileAlias[]>>
  bindAlias(request: BindProfileAliasRequest): Promise<IpcResult<ProfileAlias>>
  unbindAlias(request: UnbindProfileAliasRequest): Promise<IpcResult<boolean>>
}

/**
 * Milestone 24 (TASK-110, §6.1/§14/§15): execution profile CRUD + per-agent
 * default. Same shape as AccountPort minus the login/status machinery —
 * removal is a hard delete (execution profiles have no soft-disable
 * lifecycle), and the default lives in the config layer.
 */
export interface ExecutionProfilePort {
  list(request?: ListExecutionProfilesRequest): Promise<IpcResult<readonly AgentExecutionProfile[]>>
  get(request: ExecutionProfileIdRequest): Promise<IpcResult<AgentExecutionProfile | null>>
  create(request: CreateExecutionProfileRequest): Promise<IpcResult<AgentExecutionProfile>>
  update(request: UpdateExecutionProfileRequest): Promise<IpcResult<AgentExecutionProfile>>
  remove(request: ExecutionProfileIdRequest): Promise<IpcResult<boolean>>
  setDefault(request: SetDefaultExecutionProfileRequest): Promise<IpcResult<void>>
  getDefault(request: { agentId: string }): Promise<IpcResult<string | undefined>>
}

export interface WorkspacePort {
  create(request: CreateWorkspaceRequest): IpcResult<Workspace>
  open(request: OpenWorkspaceRequest): IpcResult<Workspace>
  remove(request: WorkspaceIdRequest): IpcResult<boolean>
  listRecent(request?: ListRecentWorkspacesRequest): IpcResult<Workspace[]>
  validate(request: OpenWorkspaceRequest): IpcResult<WorkspaceValidationResult>
  selectDirectory(request: SelectWorkspaceDirectoryRequest): Promise<IpcResult<string | null>>
  /** TASK-118: flips the workspace trust level (explicit user decision). */
  updateTrust(request: UpdateWorkspaceTrustRequest): IpcResult<Workspace>
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

/**
 * TASK-128 (ADR-0014): the persisted Decision Inbox. `resolve` is the user's
 * pick — the facade pins decidedBy to 'user'; timeout / system closures never
 * cross IPC as requests (they arrive as decision.resolved events).
 */
export interface DecisionPort {
  list(request?: ListDecisionsRequest): IpcResult<readonly PendingDecision[]>
  resolve(request: ResolveDecisionRequest): IpcResult<PendingDecision>
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
  /** `git init -b main` in the workspace cwd — the not-a-repository recovery path. */
  init(request: GitWorkspaceRequest): Promise<IpcResult<void>>
  diff(request: GitDiffRequest): Promise<IpcResult<GitRawDiff>>
  log(request: GitLogRequest): Promise<IpcResult<readonly GitCommit[]>>
  commit(request: GitCommitRequest): Promise<IpcResult<GitCommitResult>>
  changes(request: GitWorkspaceRequest): Promise<IpcResult<DiffResult>>
  filePatch(request: GitFilePatchRequest): Promise<IpcResult<GitRawDiff>>
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
  /** TASK-107 (§19/§28): continue a run under a different account identity. */
  continueWithProfile(request: ContinueAgentRunRequest): Promise<IpcResult<AgentRun>>
  send(request: SendAgentRunInputRequest): Promise<IpcResult<void>>
  resize(request: ResizeAgentRunRequest): IpcResult<void>
  cancel(request: AgentRunIdRequest): Promise<IpcResult<AgentRun>>
  get(request: AgentRunIdRequest): IpcResult<AgentRun | null>
  list(request?: ListAgentRunsRequest): IpcResult<readonly AgentRun[]>
  getOutput(request: AgentRunOutputRequest): IpcResult<string>
  /** TASK-126 (ADR-0012): persisted agent.progress events, paged by seq. */
  listProgress(request: ListAgentProgressRequest): IpcResult<readonly AgentProgressRecord[]>
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
  /**
   * P0-4: resolves with the run snapshot as soon as the pass is running —
   * suspended steps (checkpoint / criteria-gate / review-panel) do NOT keep
   * the invoke pending; progress flows through workflow.* events.
   */
  startRun(request: WorkflowRunStartRequest): Promise<IpcResult<WorkflowRunDetail>>
  cancelRun(request: WorkflowRunIdRequest): Promise<IpcResult<WorkflowRun>>
  /** User-accepts a run parked at needs_user_review, closing it as 'completed'. */
  completeRun(request: WorkflowRunIdRequest): Promise<IpcResult<WorkflowRun>>
  resolveStep(request: WorkflowStepResolveRequest): IpcResult<WorkflowStep>
  /**
   * TASK-118: user decision for a shell step parked on
   * workflow.shell_confirmation_required; true = it was awaiting a decision.
   */
  confirmShellStep(request: WorkflowShellConfirmationRequest): IpcResult<boolean>
  /**
   * Code-review P1-6: every shell confirmation still parked in Main. The
   * renderer host pulls this on (re)subscribe so a window reload never
   * strands a step in `running` on an event it missed.
   */
  listPendingShellConfirmations(
    request?: ListPendingShellConfirmationsRequest,
  ): IpcResult<readonly PendingShellConfirmation[]>
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
  readonly account: AccountPort
  readonly executionProfile: ExecutionProfilePort
  readonly git: GitPort
  readonly worktree: WorktreePort
  readonly maintenance: MaintenancePort
  readonly workflow: WorkflowPort
  readonly recovery: RecoveryPort
  readonly decision: DecisionPort
  /** P0-2: async — stops Agent/Terminal child processes before closing the DB. */
  dispose(): Promise<IpcResult<void>>
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
