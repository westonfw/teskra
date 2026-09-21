import { z } from 'zod'

import {
  accountLoginSessionSchema,
  accountProfileIdRequestSchema,
  agentAccountProfileSchema,
  cancelAccountLoginRequestSchema,
  createAccountProfileRequestSchema,
  listAccountProfilesRequestSchema,
  removeAccountProfileRequestSchema,
  resizeAccountLoginRequestSchema,
  setDefaultAccountProfileRequestSchema,
  startAccountLoginRequestSchema,
  updateAccountProfileRequestSchema,
  writeAccountLoginRequestSchema,
  type AccountLoginSession,
  type AccountProfileIdRequest,
  type AgentAccountProfile,
  type CancelAccountLoginRequest,
  type CreateAccountProfileRequest,
  type ListAccountProfilesRequest,
  type RemoveAccountProfileRequest,
  type ResizeAccountLoginRequest,
  type SetDefaultAccountProfileRequest,
  type StartAccountLoginRequest,
  type UpdateAccountProfileRequest,
  type WriteAccountLoginRequest,
} from './agent-account'
import {
  agentDefinitionSchema,
  agentDetectionRequestSchema,
  agentDetectionResultSchema,
  agentRunIdRequestSchema,
  agentRunOutputRequestSchema,
  agentRunSchema,
  agentHealthSchema,
  agentExecutableOverrideRequestSchema,
  listAgentDetectionsRequestSchema,
  listAgentRunsRequestSchema,
  resumeAgentRunRequestSchema,
  resizeAgentRunRequestSchema,
  reviewRunStartResultSchema,
  sendAgentRunInputRequestSchema,
  setAgentExecutableOverrideRequestSchema,
  startAgentRunRequestSchema,
  startReviewRunRequestSchema,
  type AgentDefinition,
  type AgentDetectionRequest,
  type AgentDetectionResult,
  type AgentRun,
  type AgentRunIdRequest,
  type AgentRunOutputRequest,
  type AgentHealth,
  type AgentExecutableOverrideRequest,
  type ListAgentDetectionsRequest,
  type ListAgentRunsRequest,
  type ResizeAgentRunRequest,
  type ResumeAgentRunRequest,
  type ReviewRunStartResult,
  type SendAgentRunInputRequest,
  type SetAgentExecutableOverrideRequest,
  type StartAgentRunRequest,
  type StartReviewRunRequest,
} from './agent'
import { continueAgentRunRequestSchema, type ContinueAgentRunRequest } from './agent-continuation'
import {
  bindProfileAliasRequestSchema,
  listProfileAliasesRequestSchema,
  profileAliasSchema,
  unbindProfileAliasRequestSchema,
  type BindProfileAliasRequest,
  type ListProfileAliasesRequest,
  type ProfileAlias,
  type UnbindProfileAliasRequest,
} from './profile-alias'
import {
  agentExecutionProfileSchema,
  createExecutionProfileRequestSchema,
  executionProfileIdRequestSchema,
  listExecutionProfilesRequestSchema,
  setDefaultExecutionProfileRequestSchema,
  updateExecutionProfileRequestSchema,
  type AgentExecutionProfile,
  type CreateExecutionProfileRequest,
  type ExecutionProfileIdRequest,
  type ListExecutionProfilesRequest,
  type SetDefaultExecutionProfileRequest,
  type UpdateExecutionProfileRequest,
} from './agent-execution-profile'
import {
  artifactContentSchema,
  artifactIdRequestSchema,
  artifactSchema,
  listArtifactsRequestSchema,
  recordArtifactRequestSchema,
  scanRunArtifactsRequestSchema,
  type Artifact,
  type ArtifactContent,
  type ArtifactIdRequest,
  type ListArtifactsRequest,
  type RecordArtifactRequest,
  type ScanRunArtifactsRequest,
} from './artifact'
import {
  credentialStoreStatusSchema,
  deleteCredentialRequestSchema,
  setCredentialRequestSchema,
  type CredentialStoreStatus,
  type DeleteCredentialRequest,
  type SetCredentialRequest,
} from './credential'
import {
  buildContextRequestSchema,
  builtContextSchema,
  type BuildContextRequest,
  type BuiltContext,
} from './context'
import { ipcResultSchema, type IpcResult } from './error'
import { handoffRecordSchema, type HandoffRecord } from './handoff'
import {
  createMemoryRequestSchema,
  listMemoriesRequestSchema,
  memoryIdRequestSchema,
  memoryRecordSchema,
  updateMemoryRequestSchema,
  type CreateMemoryRequest,
  type ListMemoriesRequest,
  type Memory,
  type MemoryIdRequest,
  type UpdateMemoryRequest,
} from './memory'
import {
  createPermissionRuleRequestSchema,
  listPermissionAuditRequestSchema,
  listPermissionRulesRequestSchema,
  permissionAuditEntrySchema,
  permissionDecisionResultSchema,
  permissionRuleIdRequestSchema,
  permissionRuleSchema,
  resolvePermissionDecisionRequestSchema,
  resolvePermissionProfileRequestSchema,
  resolvedPermissionProfileSchema,
  updatePermissionRuleRequestSchema,
  type CreatePermissionRuleRequest,
  type ListPermissionAuditRequest,
  type ListPermissionRulesRequest,
  type PermissionAuditEntry,
  type PermissionDecisionResult,
  type PermissionRule,
  type PermissionRuleIdRequest,
  type ResolvePermissionDecisionRequest,
  type ResolvePermissionProfileRequest,
  type ResolvedPermissionProfile,
  type UpdatePermissionRuleRequest,
} from './permission'
import {
  criterionScoreRecordSchema,
  listCriterionScoresRequestSchema,
  listReviewFindingsRequestSchema,
  listReviewPanelsRequestSchema,
  reviewFindingRecordSchema,
  reviewPanelIdRequestSchema,
  reviewPanelResultSchema,
  reviewPanelSchema,
  startReviewPanelRequestSchema,
  type CriterionScoreRecord,
  type ListCriterionScoresRequest,
  type ListReviewFindingsRequest,
  type ListReviewPanelsRequest,
  type ReviewFindingRecord,
  type ReviewPanel,
  type ReviewPanelIdRequest,
  type ReviewPanelResult,
  type StartReviewPanelRequest,
} from './review'
import {
  acceptanceCriteriaSetDetailSchema,
  acceptanceCriteriaSetSchema,
  acceptanceCriterionSchema,
  addCriterionRequestSchema,
  bindRunCriteriaRequestSchema,
  createCriteriaSetRequestSchema,
  criteriaSetIdRequestSchema,
  criterionIdRequestSchema,
  listCriteriaSetsRequestSchema,
  updateCriterionRequestSchema,
  type AcceptanceCriteriaSet,
  type AcceptanceCriteriaSetDetail,
  type AcceptanceCriterion,
  type AddCriterionRequest,
  type BindRunCriteriaRequest,
  type CreateCriteriaSetRequest,
  type CriteriaSetIdRequest,
  type CriterionIdRequest,
  type ListCriteriaSetsRequest,
  type UpdateCriterionRequest,
} from './criteria'
import {
  doctorReportSchema,
  runDoctorRequestSchema,
  type DoctorReport,
  type RunDoctorRequest,
} from './doctor'
import {
  listRecoveryIssuesRequestSchema,
  recoveryReportSchema,
  type ListRecoveryIssuesRequest,
  type RecoveryReport,
} from './recovery'
import type { WorkbenchEventName, WorkbenchEvents } from './event'
import {
  retentionPlanRequestSchema,
  retentionPlanSchema,
  retentionReportSchema,
  retentionRunRequestSchema,
  type RetentionPlan,
  type RetentionPlanRequest,
  type RetentionReport,
  type RetentionRunRequest,
} from './maintenance'
import {
  listPromptTemplatesRequestSchema,
  promptTemplateInfoSchema,
  renderPromptTemplateRequestSchema,
  renderedPromptSchema,
  type ListPromptTemplatesRequest,
  type PromptTemplateInfo,
  type RenderedPrompt,
  type RenderPromptTemplateRequest,
} from './prompt'
import {
  diffResultSchema,
  gitBranchSchema,
  gitCommitRequestSchema,
  gitCommitResultSchema,
  gitCommitSchema,
  gitDiffRequestSchema,
  gitFilePatchRequestSchema,
  gitLogRequestSchema,
  gitOpenFileRequestSchema,
  gitRawDiffSchema,
  gitStatusSchema,
  gitWorkspaceRequestSchema,
  mergePreflightResultSchema,
  worktreeCleanupRequestSchema,
  worktreeCleanupResultSchema,
  worktreeCreateRequestSchema,
  worktreeDiscardRequestSchema,
  worktreeIdRequestSchema,
  worktreeListRequestSchema,
  worktreeMergeRequestSchema,
  worktreeMergeResultSchema,
  worktreeSchema,
  type DiffResult,
  type GitBranch,
  type GitCommit,
  type GitCommitRequest,
  type GitCommitResult,
  type GitDiffRequest,
  type GitFilePatchRequest,
  type GitLogRequest,
  type GitOpenFileRequest,
  type GitRawDiff,
  type GitStatus,
  type GitWorkspaceRequest,
  type MergePreflightResult,
  type Worktree,
  type WorktreeCleanupRequest,
  type WorktreeCleanupResult,
  type WorktreeCreateRequest,
  type WorktreeDiscardRequest,
  type WorktreeIdRequest,
  type WorktreeListRequest,
  type WorktreeMergeRequest,
  type WorktreeMergeResult,
} from './git'
import {
  archiveTaskRequestSchema,
  createTaskRequestSchema,
  listTasksRequestSchema,
  taskIdRequestSchema,
  taskSchema,
  updateTaskRequestSchema,
  type ArchiveTaskRequest,
  type CreateTaskRequest,
  type ListTasksRequest,
  type Task,
  type TaskIdRequest,
  type UpdateTaskRequest,
} from './task'
import {
  resolveConfigRequestSchema,
  resolvedConfigSchema,
  updateConfigRequestSchema,
  type ResolveConfigRequest,
  type ResolvedConfig,
  type UpdateConfigRequest,
} from './config'
import {
  openSystemDirectoryRequestSchema,
  requireRuntimePortRequestSchema,
  setDefaultWslDistributionRequestSchema,
  systemHealthSchema,
  systemInfoSchema,
  systemPathsSchema,
  type OpenSystemDirectoryRequest,
  type RequireRuntimePortRequest,
  type SetDefaultWslDistributionRequest,
  type SystemHealth,
  type SystemInfo,
  type SystemPaths,
} from './system'
import {
  createTerminalRequestSchema,
  listTerminalsRequestSchema,
  terminalCloseRequestSchema,
  terminalIdRequestSchema,
  terminalResizeRequestSchema,
  terminalSessionSchema,
  terminalWriteRequestSchema,
  type CreateTerminalRequest,
  type ListTerminalsRequest,
  type TerminalCloseRequest,
  type TerminalIdRequest,
  type TerminalResizeRequest,
  type TerminalSession,
  type TerminalWriteRequest,
} from './terminal'
import {
  createWorkspaceRequestSchema,
  listRecentWorkspacesRequestSchema,
  openWorkspaceRequestSchema,
  selectWorkspaceDirectoryRequestSchema,
  updateWorkspaceTrustRequestSchema,
  workspaceIdRequestSchema,
  workspaceSchema,
  workspaceValidationSchema,
  type CreateWorkspaceRequest,
  type ListRecentWorkspacesRequest,
  type OpenWorkspaceRequest,
  type SelectWorkspaceDirectoryRequest,
  type UpdateWorkspaceTrustRequest,
  type Workspace,
  type WorkspaceIdRequest,
  type WorkspaceValidationResult,
} from './workspace'
import {
  wslDistributionSchema,
  wslEnvironmentSchema,
  type WslDistribution,
  type WslEnvironment,
} from './wsl'
import {
  fullWorkflowRunSummarySchema,
  fullWorkflowStartResultSchema,
  listPendingShellConfirmationsRequestSchema,
  listWorkflowDefinitionsRequestSchema,
  listWorkflowRunsRequestSchema,
  loadWorkflowDefinitionRequestSchema,
  pendingShellConfirmationSchema,
  startFullWorkflowRequestSchema,
  workflowDefinitionFileInfoSchema,
  workflowDefinitionSchema,
  workflowDispatchRequestSchema,
  workflowDispatchResultSchema,
  workflowIterateRequestSchema,
  workflowIterateResultSchema,
  workflowRunDetailSchema,
  workflowRunIdRequestSchema,
  workflowRunSchema,
  workflowRunStartRequestSchema,
  workflowShellConfirmationRequestSchema,
  workflowStepResolveRequestSchema,
  workflowStepSchema,
  type FullWorkflowRunSummary,
  type FullWorkflowStartResult,
  type ListPendingShellConfirmationsRequest,
  type ListWorkflowDefinitionsRequest,
  type ListWorkflowRunsRequest,
  type LoadWorkflowDefinitionRequest,
  type PendingShellConfirmation,
  type StartFullWorkflowRequest,
  type WorkflowDefinition,
  type WorkflowDefinitionFileInfo,
  type WorkflowDispatchRequest,
  type WorkflowDispatchResult,
  type WorkflowIterateRequest,
  type WorkflowIterateResult,
  type WorkflowRun,
  type WorkflowRunDetail,
  type WorkflowRunIdRequest,
  type WorkflowRunStartRequest,
  type WorkflowShellConfirmationRequest,
  type WorkflowStep,
  type WorkflowStepResolveRequest,
} from './workflow'

export const IPC_CHANNELS = {
  ping: 'teskra:ping',
  workspaceCreate: 'teskra:workspace:create',
  workspaceOpen: 'teskra:workspace:open',
  workspaceRemove: 'teskra:workspace:remove',
  workspaceListRecent: 'teskra:workspace:list-recent',
  workspaceValidate: 'teskra:workspace:validate',
  workspaceSelectDirectory: 'teskra:workspace:select-directory',
  workspaceUpdateTrust: 'teskra:workspace:update-trust',
  taskCreate: 'teskra:task:create',
  taskUpdate: 'teskra:task:update',
  taskArchive: 'teskra:task:archive',
  taskDelete: 'teskra:task:delete',
  taskGet: 'teskra:task:get',
  taskList: 'teskra:task:list',
  criteriaListSets: 'teskra:criteria:list-sets',
  criteriaGetSet: 'teskra:criteria:get-set',
  criteriaCreateSet: 'teskra:criteria:create-set',
  criteriaAddCriterion: 'teskra:criteria:add-criterion',
  criteriaUpdateCriterion: 'teskra:criteria:update-criterion',
  criteriaRemoveCriterion: 'teskra:criteria:remove-criterion',
  criteriaConfirmSet: 'teskra:criteria:confirm-set',
  criteriaSupersedeSet: 'teskra:criteria:supersede-set',
  criteriaBindRun: 'teskra:criteria:bind-run',
  artifactRecord: 'teskra:artifact:record',
  artifactList: 'teskra:artifact:list',
  artifactGet: 'teskra:artifact:get',
  artifactScanRun: 'teskra:artifact:scan-run',
  handoffGet: 'teskra:handoff:get',
  memoryList: 'teskra:memory:list',
  memoryGet: 'teskra:memory:get',
  memoryCreate: 'teskra:memory:create',
  memoryUpdate: 'teskra:memory:update',
  memoryDelete: 'teskra:memory:delete',
  contextPreview: 'teskra:context:preview',
  reviewListFindings: 'teskra:review:findings:list',
  reviewListCriterionScores: 'teskra:review:criterion-scores:list',
  reviewPanelStart: 'teskra:review:panel:start',
  reviewPanelGet: 'teskra:review:panel:get',
  reviewPanelList: 'teskra:review:panel:list',
  agentListDefinitions: 'teskra:agent:list-definitions',
  agentDetect: 'teskra:agent:detect',
  agentListDetections: 'teskra:agent:list-detections',
  agentCheckHealth: 'teskra:agent:health:check',
  agentListHealth: 'teskra:agent:health:list',
  agentGetPathOverride: 'teskra:agent:path-override:get',
  agentSetPathOverride: 'teskra:agent:path-override:set',
  agentRunStart: 'teskra:agent-run:start',
  agentRunReviewStart: 'teskra:agent-run:review-start',
  agentRunSend: 'teskra:agent-run:send',
  agentRunResize: 'teskra:agent-run:resize',
  agentRunCancel: 'teskra:agent-run:cancel',
  agentRunGet: 'teskra:agent-run:get',
  agentRunList: 'teskra:agent-run:list',
  agentRunOutput: 'teskra:agent-run:output',
  agentRunResume: 'teskra:agent-run:resume',
  agentRunContinueWithProfile: 'teskra:agent:continue-with-profile',
  accountList: 'teskra:account:list',
  accountGet: 'teskra:account:get',
  accountCreate: 'teskra:account:create',
  accountUpdate: 'teskra:account:update',
  accountRemove: 'teskra:account:remove',
  accountDetect: 'teskra:account:detect',
  accountDisable: 'teskra:account:disable',
  accountEnable: 'teskra:account:enable',
  accountSetDefault: 'teskra:account:set-default',
  accountLoginStart: 'teskra:account:login:start',
  accountLoginWrite: 'teskra:account:login:write',
  accountLoginResize: 'teskra:account:login:resize',
  accountLoginCancel: 'teskra:account:login:cancel',
  accountAliasList: 'teskra:account:alias:list',
  accountAliasBind: 'teskra:account:alias:bind',
  accountAliasUnbind: 'teskra:account:alias:unbind',
  executionProfileList: 'teskra:execution-profile:list',
  executionProfileGet: 'teskra:execution-profile:get',
  executionProfileCreate: 'teskra:execution-profile:create',
  executionProfileUpdate: 'teskra:execution-profile:update',
  executionProfileRemove: 'teskra:execution-profile:remove',
  executionProfileSetDefault: 'teskra:execution-profile:set-default',
  permissionListRules: 'teskra:permission:rule:list',
  permissionCreateRule: 'teskra:permission:rule:create',
  permissionUpdateRule: 'teskra:permission:rule:update',
  permissionDeleteRule: 'teskra:permission:rule:delete',
  permissionListAudit: 'teskra:permission:audit:list',
  permissionResolveProfile: 'teskra:permission:profile:resolve',
  permissionResolveDecision: 'teskra:permission:decision:resolve',
  gitStatus: 'teskra:git:status',
  gitBranch: 'teskra:git:branch',
  gitDiff: 'teskra:git:diff',
  gitLog: 'teskra:git:log',
  gitCommit: 'teskra:git:commit',
  gitChanges: 'teskra:git:changes',
  gitFilePatch: 'teskra:git:file-patch',
  gitOpenFile: 'teskra:git:open-file',
  worktreeCreate: 'teskra:worktree:create',
  worktreeList: 'teskra:worktree:list',
  worktreeValidate: 'teskra:worktree:validate',
  worktreeMergePreflight: 'teskra:worktree:preflight',
  worktreeMerge: 'teskra:worktree:merge',
  worktreeDiscard: 'teskra:worktree:discard',
  worktreeArchive: 'teskra:worktree:archive',
  worktreeCleanup: 'teskra:worktree:cleanup',
  maintenanceRetentionPlan: 'teskra:maintenance:retention:plan',
  maintenanceRetentionRun: 'teskra:maintenance:retention:run',
  maintenanceRetentionCancel: 'teskra:maintenance:retention:cancel',
  terminalCreate: 'teskra:terminal:create',
  terminalWrite: 'teskra:terminal:write',
  terminalResize: 'teskra:terminal:resize',
  terminalClose: 'teskra:terminal:close',
  terminalGet: 'teskra:terminal:get',
  terminalList: 'teskra:terminal:list',
  runtimeInfo: 'teskra:runtime:info',
  runtimePaths: 'teskra:runtime:paths',
  runtimeHealth: 'teskra:runtime:health',
  runtimeInspectWsl: 'teskra:runtime:wsl:inspect',
  runtimeListWsl: 'teskra:runtime:wsl:list',
  runtimeGetDefaultWsl: 'teskra:runtime:wsl:get-default',
  runtimeSetDefaultWsl: 'teskra:runtime:wsl:set-default',
  runtimeRequireCapability: 'teskra:runtime:require-capability',
  settingsResolveConfig: 'teskra:settings:config:resolve',
  settingsUpdateConfig: 'teskra:settings:config:update',
  credentialStatus: 'teskra:credential:status',
  credentialSet: 'teskra:credential:set',
  credentialDelete: 'teskra:credential:delete',
  credentialList: 'teskra:credential:list',
  systemOpenDirectory: 'teskra:system:directory:open',
  doctorRun: 'teskra:doctor:run',
  recoveryList: 'teskra:recovery:list',
  promptListTemplates: 'teskra:prompt:list-templates',
  promptRender: 'teskra:prompt:render',
  workflowListDefinitions: 'teskra:workflow:definitions:list',
  workflowLoadDefinition: 'teskra:workflow:definition:load',
  workflowRunList: 'teskra:workflow:run:list',
  workflowRunGet: 'teskra:workflow:run:get',
  workflowRunStart: 'teskra:workflow:run:start',
  workflowRunCancel: 'teskra:workflow:run:cancel',
  workflowRunComplete: 'teskra:workflow:run:complete',
  workflowStepResolve: 'teskra:workflow:step:resolve',
  workflowShellConfirmation: 'teskra:workflow:shell:confirm',
  workflowListPendingShellConfirmations: 'teskra:workflow:shell:pending-confirmations:list',
  workflowDispatch: 'teskra:workflow:dispatch',
  workflowIterate: 'teskra:workflow:iterate',
  workflowStartFull: 'teskra:workflow:start-full',
  workflowRunSummary: 'teskra:workflow:run:summary',
} as const
export type IpcChannelName = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

export interface IpcChannelDefinition<Req, Res> {
  readonly channel: IpcChannelName
  readonly request: z.ZodType<Req>
  readonly response: z.ZodType<IpcResult<Res>>
}

function channel<Req, Res>(
  name: IpcChannelName,
  request: z.ZodType<Req>,
  responseData: z.ZodType<Res>,
): IpcChannelDefinition<Req, Res> {
  return { channel: name, request, response: ipcResultSchema(responseData) }
}

export const pingRequestSchema = z.void()
const noRequestSchema = z.void()
const voidResponseSchema = z.void()

export const pingResponseSchema = ipcResultSchema(z.string())
export const pingChannel: IpcChannelDefinition<void, string> = {
  channel: IPC_CHANNELS.ping,
  request: pingRequestSchema,
  response: pingResponseSchema,
}
export const workspaceCreateChannel = channel(
  IPC_CHANNELS.workspaceCreate,
  createWorkspaceRequestSchema,
  workspaceSchema,
)
export const workspaceOpenChannel = channel(
  IPC_CHANNELS.workspaceOpen,
  openWorkspaceRequestSchema,
  workspaceSchema,
)
export const workspaceRemoveChannel = channel(
  IPC_CHANNELS.workspaceRemove,
  workspaceIdRequestSchema,
  z.boolean(),
)
export const workspaceListRecentChannel = channel(
  IPC_CHANNELS.workspaceListRecent,
  listRecentWorkspacesRequestSchema,
  z.array(workspaceSchema),
)
export const workspaceValidateChannel = channel(
  IPC_CHANNELS.workspaceValidate,
  openWorkspaceRequestSchema,
  workspaceValidationSchema,
)
export const workspaceSelectDirectoryChannel = channel(
  IPC_CHANNELS.workspaceSelectDirectory,
  selectWorkspaceDirectoryRequestSchema,
  z.string().nullable(),
)
export const workspaceUpdateTrustChannel = channel(
  IPC_CHANNELS.workspaceUpdateTrust,
  updateWorkspaceTrustRequestSchema,
  workspaceSchema,
)
export const taskCreateChannel = channel(
  IPC_CHANNELS.taskCreate,
  createTaskRequestSchema,
  taskSchema,
)
export const taskUpdateChannel = channel(
  IPC_CHANNELS.taskUpdate,
  updateTaskRequestSchema,
  taskSchema,
)
export const taskArchiveChannel = channel(
  IPC_CHANNELS.taskArchive,
  archiveTaskRequestSchema,
  taskSchema,
)
export const taskDeleteChannel = channel(IPC_CHANNELS.taskDelete, taskIdRequestSchema, z.boolean())
export const taskGetChannel = channel(
  IPC_CHANNELS.taskGet,
  taskIdRequestSchema,
  taskSchema.nullable(),
)
export const taskListChannel = channel(
  IPC_CHANNELS.taskList,
  listTasksRequestSchema,
  z.array(taskSchema),
)
export const criteriaListSetsChannel = channel(
  IPC_CHANNELS.criteriaListSets,
  listCriteriaSetsRequestSchema,
  z.array(acceptanceCriteriaSetSchema),
)
export const criteriaGetSetChannel = channel(
  IPC_CHANNELS.criteriaGetSet,
  criteriaSetIdRequestSchema,
  acceptanceCriteriaSetDetailSchema.nullable(),
)
export const criteriaCreateSetChannel = channel(
  IPC_CHANNELS.criteriaCreateSet,
  createCriteriaSetRequestSchema,
  acceptanceCriteriaSetDetailSchema,
)
export const criteriaAddCriterionChannel = channel(
  IPC_CHANNELS.criteriaAddCriterion,
  addCriterionRequestSchema,
  acceptanceCriterionSchema,
)
export const criteriaUpdateCriterionChannel = channel(
  IPC_CHANNELS.criteriaUpdateCriterion,
  updateCriterionRequestSchema,
  acceptanceCriterionSchema,
)
export const criteriaRemoveCriterionChannel = channel(
  IPC_CHANNELS.criteriaRemoveCriterion,
  criterionIdRequestSchema,
  z.boolean(),
)
export const criteriaConfirmSetChannel = channel(
  IPC_CHANNELS.criteriaConfirmSet,
  criteriaSetIdRequestSchema,
  acceptanceCriteriaSetSchema,
)
export const criteriaSupersedeSetChannel = channel(
  IPC_CHANNELS.criteriaSupersedeSet,
  criteriaSetIdRequestSchema,
  acceptanceCriteriaSetSchema,
)
export const criteriaBindRunChannel = channel(
  IPC_CHANNELS.criteriaBindRun,
  bindRunCriteriaRequestSchema,
  agentRunSchema,
)
export const artifactRecordChannel = channel(
  IPC_CHANNELS.artifactRecord,
  recordArtifactRequestSchema,
  artifactSchema,
)
export const artifactListChannel = channel(
  IPC_CHANNELS.artifactList,
  listArtifactsRequestSchema,
  z.array(artifactSchema),
)
export const artifactGetChannel = channel(
  IPC_CHANNELS.artifactGet,
  artifactIdRequestSchema,
  artifactContentSchema.nullable(),
)
export const artifactScanRunChannel = channel(
  IPC_CHANNELS.artifactScanRun,
  scanRunArtifactsRequestSchema,
  z.array(artifactSchema),
)
export const handoffGetChannel = channel(
  IPC_CHANNELS.handoffGet,
  agentRunIdRequestSchema,
  handoffRecordSchema.nullable(),
)
// TASK-067: repo-local memories (`file:` ids) are read-only — update/delete on
// them fails with VALIDATION_FAILED at the MemoryManager, never silently.
export const memoryListChannel = channel(
  IPC_CHANNELS.memoryList,
  listMemoriesRequestSchema,
  z.array(memoryRecordSchema),
)
export const memoryGetChannel = channel(
  IPC_CHANNELS.memoryGet,
  memoryIdRequestSchema,
  memoryRecordSchema.nullable(),
)
export const memoryCreateChannel = channel(
  IPC_CHANNELS.memoryCreate,
  createMemoryRequestSchema,
  memoryRecordSchema,
)
export const memoryUpdateChannel = channel(
  IPC_CHANNELS.memoryUpdate,
  updateMemoryRequestSchema,
  memoryRecordSchema.nullable(),
)
export const memoryDeleteChannel = channel(
  IPC_CHANNELS.memoryDelete,
  memoryIdRequestSchema,
  z.boolean(),
)
// TASK-068: read-only preview of the packed ContextBuilder output.
export const contextPreviewChannel = channel(
  IPC_CHANNELS.contextPreview,
  buildContextRequestSchema,
  builtContextSchema,
)
export const reviewListFindingsChannel = channel(
  IPC_CHANNELS.reviewListFindings,
  listReviewFindingsRequestSchema,
  z.array(reviewFindingRecordSchema),
)
export const reviewListCriterionScoresChannel = channel(
  IPC_CHANNELS.reviewListCriterionScores,
  listCriterionScoresRequestSchema,
  z.array(criterionScoreRecordSchema),
)
export const reviewPanelStartChannel = channel(
  IPC_CHANNELS.reviewPanelStart,
  startReviewPanelRequestSchema,
  reviewPanelResultSchema,
)
export const reviewPanelGetChannel = channel(
  IPC_CHANNELS.reviewPanelGet,
  reviewPanelIdRequestSchema,
  reviewPanelResultSchema.nullable(),
)
export const reviewPanelListChannel = channel(
  IPC_CHANNELS.reviewPanelList,
  listReviewPanelsRequestSchema,
  z.array(reviewPanelSchema),
)
export const agentListDefinitionsChannel = channel(
  IPC_CHANNELS.agentListDefinitions,
  noRequestSchema,
  z.array(agentDefinitionSchema),
)
export const agentDetectChannel = channel(
  IPC_CHANNELS.agentDetect,
  agentDetectionRequestSchema,
  agentDetectionResultSchema,
)
export const agentListDetectionsChannel = channel(
  IPC_CHANNELS.agentListDetections,
  listAgentDetectionsRequestSchema,
  z.array(agentDetectionResultSchema),
)
export const agentCheckHealthChannel = channel(
  IPC_CHANNELS.agentCheckHealth,
  agentDetectionRequestSchema,
  agentHealthSchema,
)
export const agentListHealthChannel = channel(
  IPC_CHANNELS.agentListHealth,
  listAgentDetectionsRequestSchema,
  z.array(agentHealthSchema),
)
export const agentGetExecutableOverrideChannel = channel(
  IPC_CHANNELS.agentGetPathOverride,
  agentExecutableOverrideRequestSchema,
  z.string().nullable(),
)
export const agentSetExecutableOverrideChannel = channel(
  IPC_CHANNELS.agentSetPathOverride,
  setAgentExecutableOverrideRequestSchema,
  z.string().nullable(),
)
export const agentRunStartChannel = channel(
  IPC_CHANNELS.agentRunStart,
  startAgentRunRequestSchema,
  agentRunSchema,
)
export const agentRunReviewStartChannel = channel(
  IPC_CHANNELS.agentRunReviewStart,
  startReviewRunRequestSchema,
  reviewRunStartResultSchema,
)
export const agentRunSendChannel = channel(
  IPC_CHANNELS.agentRunSend,
  sendAgentRunInputRequestSchema,
  voidResponseSchema,
)
export const agentRunResizeChannel = channel(
  IPC_CHANNELS.agentRunResize,
  resizeAgentRunRequestSchema,
  voidResponseSchema,
)
export const agentRunCancelChannel = channel(
  IPC_CHANNELS.agentRunCancel,
  agentRunIdRequestSchema,
  agentRunSchema,
)
export const agentRunGetChannel = channel(
  IPC_CHANNELS.agentRunGet,
  agentRunIdRequestSchema,
  agentRunSchema.nullable(),
)
export const agentRunListChannel = channel(
  IPC_CHANNELS.agentRunList,
  listAgentRunsRequestSchema,
  z.array(agentRunSchema),
)
export const agentRunOutputChannel = channel(
  IPC_CHANNELS.agentRunOutput,
  agentRunOutputRequestSchema,
  z.string(),
)
export const agentRunResumeChannel = channel(
  IPC_CHANNELS.agentRunResume,
  resumeAgentRunRequestSchema,
  agentRunSchema,
)
// TASK-107 (Milestone 24 §19/§28): cross-profile continuation — a NEW run on
// the same task + worktree under a different account identity.
export const agentRunContinueWithProfileChannel = channel(
  IPC_CHANNELS.agentRunContinueWithProfile,
  continueAgentRunRequestSchema,
  agentRunSchema,
)
// TASK-102 (Milestone 24 §28): account profile CRUD + default + status detect.
// The alias channels (TASK-111) live right after the login session block.
export const accountListChannel = channel(
  IPC_CHANNELS.accountList,
  listAccountProfilesRequestSchema,
  z.array(agentAccountProfileSchema),
)
export const accountGetChannel = channel(
  IPC_CHANNELS.accountGet,
  accountProfileIdRequestSchema,
  agentAccountProfileSchema.nullable(),
)
export const accountCreateChannel = channel(
  IPC_CHANNELS.accountCreate,
  createAccountProfileRequestSchema,
  agentAccountProfileSchema,
)
export const accountUpdateChannel = channel(
  IPC_CHANNELS.accountUpdate,
  updateAccountProfileRequestSchema,
  agentAccountProfileSchema,
)
export const accountRemoveChannel = channel(
  IPC_CHANNELS.accountRemove,
  removeAccountProfileRequestSchema,
  agentAccountProfileSchema,
)
export const accountDetectChannel = channel(
  IPC_CHANNELS.accountDetect,
  accountProfileIdRequestSchema,
  agentAccountProfileSchema,
)
export const accountDisableChannel = channel(
  IPC_CHANNELS.accountDisable,
  accountProfileIdRequestSchema,
  agentAccountProfileSchema,
)
export const accountEnableChannel = channel(
  IPC_CHANNELS.accountEnable,
  accountProfileIdRequestSchema,
  agentAccountProfileSchema,
)
export const accountSetDefaultChannel = channel(
  IPC_CHANNELS.accountSetDefault,
  setDefaultAccountProfileRequestSchema,
  voidResponseSchema,
)
// §24.2: login is an interactive session (four channels + two events), never
// a single blocking invoke — start returns the session handle immediately.
export const accountLoginStartChannel = channel(
  IPC_CHANNELS.accountLoginStart,
  startAccountLoginRequestSchema,
  accountLoginSessionSchema,
)
export const accountLoginWriteChannel = channel(
  IPC_CHANNELS.accountLoginWrite,
  writeAccountLoginRequestSchema,
  voidResponseSchema,
)
export const accountLoginResizeChannel = channel(
  IPC_CHANNELS.accountLoginResize,
  resizeAccountLoginRequestSchema,
  voidResponseSchema,
)
export const accountLoginCancelChannel = channel(
  IPC_CHANNELS.accountLoginCancel,
  cancelAccountLoginRequestSchema,
  voidResponseSchema,
)
// TASK-111 (Milestone 24 §28/§53.1): workflow profile alias bindings. `kind`
// is required on bind/unbind — the primary key is (agentId, kind, alias) and
// the two Profile tables' id namespaces cannot be assumed disjoint.
export const accountAliasListChannel = channel(
  IPC_CHANNELS.accountAliasList,
  listProfileAliasesRequestSchema,
  z.array(profileAliasSchema),
)
export const accountAliasBindChannel = channel(
  IPC_CHANNELS.accountAliasBind,
  bindProfileAliasRequestSchema,
  profileAliasSchema,
)
export const accountAliasUnbindChannel = channel(
  IPC_CHANNELS.accountAliasUnbind,
  unbindProfileAliasRequestSchema,
  z.boolean(),
)
// TASK-110 (Milestone 24 §6.1/§14): execution profile CRUD + per-agent
// default. Same shape as the account domain; the default itself is stored in
// the config layer (agents.defaultExecutionProfiles) and can also be read via
// settings.resolveConfig, so there is no get-default channel (mirrors account).
export const executionProfileListChannel = channel(
  IPC_CHANNELS.executionProfileList,
  listExecutionProfilesRequestSchema,
  z.array(agentExecutionProfileSchema),
)
export const executionProfileGetChannel = channel(
  IPC_CHANNELS.executionProfileGet,
  executionProfileIdRequestSchema,
  agentExecutionProfileSchema.nullable(),
)
export const executionProfileCreateChannel = channel(
  IPC_CHANNELS.executionProfileCreate,
  createExecutionProfileRequestSchema,
  agentExecutionProfileSchema,
)
export const executionProfileUpdateChannel = channel(
  IPC_CHANNELS.executionProfileUpdate,
  updateExecutionProfileRequestSchema,
  agentExecutionProfileSchema,
)
export const executionProfileRemoveChannel = channel(
  IPC_CHANNELS.executionProfileRemove,
  executionProfileIdRequestSchema,
  z.boolean(),
)
export const executionProfileSetDefaultChannel = channel(
  IPC_CHANNELS.executionProfileSetDefault,
  setDefaultExecutionProfileRequestSchema,
  voidResponseSchema,
)
export const permissionListRulesChannel = channel(
  IPC_CHANNELS.permissionListRules,
  listPermissionRulesRequestSchema,
  z.array(permissionRuleSchema),
)
export const permissionCreateRuleChannel = channel(
  IPC_CHANNELS.permissionCreateRule,
  createPermissionRuleRequestSchema,
  permissionRuleSchema,
)
export const permissionUpdateRuleChannel = channel(
  IPC_CHANNELS.permissionUpdateRule,
  updatePermissionRuleRequestSchema,
  permissionRuleSchema.nullable(),
)
export const permissionDeleteRuleChannel = channel(
  IPC_CHANNELS.permissionDeleteRule,
  permissionRuleIdRequestSchema,
  z.boolean(),
)
export const permissionListAuditChannel = channel(
  IPC_CHANNELS.permissionListAudit,
  listPermissionAuditRequestSchema,
  z.array(permissionAuditEntrySchema),
)
export const permissionResolveProfileChannel = channel(
  IPC_CHANNELS.permissionResolveProfile,
  resolvePermissionProfileRequestSchema,
  resolvedPermissionProfileSchema,
)
export const permissionResolveDecisionChannel = channel(
  IPC_CHANNELS.permissionResolveDecision,
  resolvePermissionDecisionRequestSchema,
  permissionDecisionResultSchema,
)
export const gitStatusChannel = channel(
  IPC_CHANNELS.gitStatus,
  gitWorkspaceRequestSchema,
  gitStatusSchema,
)
export const gitBranchChannel = channel(
  IPC_CHANNELS.gitBranch,
  gitWorkspaceRequestSchema,
  gitBranchSchema,
)
export const gitDiffChannel = channel(IPC_CHANNELS.gitDiff, gitDiffRequestSchema, gitRawDiffSchema)
export const gitLogChannel = channel(
  IPC_CHANNELS.gitLog,
  gitLogRequestSchema,
  z.array(gitCommitSchema),
)
export const gitCommitChannel = channel(
  IPC_CHANNELS.gitCommit,
  gitCommitRequestSchema,
  gitCommitResultSchema,
)
export const gitChangesChannel = channel(
  IPC_CHANNELS.gitChanges,
  gitWorkspaceRequestSchema,
  diffResultSchema,
)
export const gitFilePatchChannel = channel(
  IPC_CHANNELS.gitFilePatch,
  gitFilePatchRequestSchema,
  gitRawDiffSchema,
)
export const gitOpenFileChannel = channel(
  IPC_CHANNELS.gitOpenFile,
  gitOpenFileRequestSchema,
  voidResponseSchema,
)
export const worktreeCreateChannel = channel(
  IPC_CHANNELS.worktreeCreate,
  worktreeCreateRequestSchema,
  worktreeSchema,
)
export const worktreeListChannel = channel(
  IPC_CHANNELS.worktreeList,
  worktreeListRequestSchema,
  z.array(worktreeSchema),
)
export const worktreeValidateChannel = channel(
  IPC_CHANNELS.worktreeValidate,
  worktreeIdRequestSchema,
  worktreeSchema,
)
export const worktreeMergePreflightChannel = channel(
  IPC_CHANNELS.worktreeMergePreflight,
  worktreeIdRequestSchema,
  mergePreflightResultSchema,
)
export const worktreeMergeChannel = channel(
  IPC_CHANNELS.worktreeMerge,
  worktreeMergeRequestSchema,
  worktreeMergeResultSchema,
)
export const worktreeDiscardChannel = channel(
  IPC_CHANNELS.worktreeDiscard,
  worktreeDiscardRequestSchema,
  worktreeSchema,
)
export const worktreeArchiveChannel = channel(
  IPC_CHANNELS.worktreeArchive,
  worktreeIdRequestSchema,
  worktreeSchema,
)
export const worktreeCleanupChannel = channel(
  IPC_CHANNELS.worktreeCleanup,
  worktreeCleanupRequestSchema,
  worktreeCleanupResultSchema,
)
// TASK-069 RetentionService: plan() is the dry-run preview; run() executes
// the GC; cancel() aborts the in-flight run between items.
export const maintenanceRetentionPlanChannel = channel(
  IPC_CHANNELS.maintenanceRetentionPlan,
  retentionPlanRequestSchema,
  retentionPlanSchema,
)
export const maintenanceRetentionRunChannel = channel(
  IPC_CHANNELS.maintenanceRetentionRun,
  retentionRunRequestSchema,
  retentionReportSchema,
)
export const maintenanceRetentionCancelChannel = channel(
  IPC_CHANNELS.maintenanceRetentionCancel,
  noRequestSchema,
  z.boolean(),
)
export const terminalCreateChannel = channel(
  IPC_CHANNELS.terminalCreate,
  createTerminalRequestSchema,
  terminalSessionSchema,
)
export const terminalWriteChannel = channel(
  IPC_CHANNELS.terminalWrite,
  terminalWriteRequestSchema,
  voidResponseSchema,
)
export const terminalResizeChannel = channel(
  IPC_CHANNELS.terminalResize,
  terminalResizeRequestSchema,
  voidResponseSchema,
)
export const terminalCloseChannel = channel(
  IPC_CHANNELS.terminalClose,
  terminalCloseRequestSchema,
  voidResponseSchema,
)
export const terminalGetChannel = channel(
  IPC_CHANNELS.terminalGet,
  terminalIdRequestSchema,
  terminalSessionSchema.nullable(),
)
export const terminalListChannel = channel(
  IPC_CHANNELS.terminalList,
  listTerminalsRequestSchema,
  z.array(terminalSessionSchema),
)
export const runtimeInfoChannel = channel(
  IPC_CHANNELS.runtimeInfo,
  noRequestSchema,
  systemInfoSchema,
)
export const runtimePathsChannel = channel(
  IPC_CHANNELS.runtimePaths,
  noRequestSchema,
  systemPathsSchema,
)
export const runtimeHealthChannel = channel(
  IPC_CHANNELS.runtimeHealth,
  noRequestSchema,
  systemHealthSchema,
)
export const runtimeInspectWslChannel = channel(
  IPC_CHANNELS.runtimeInspectWsl,
  noRequestSchema,
  wslEnvironmentSchema,
)
export const runtimeListWslChannel = channel(
  IPC_CHANNELS.runtimeListWsl,
  noRequestSchema,
  z.array(wslDistributionSchema),
)
export const runtimeGetDefaultWslChannel = channel(
  IPC_CHANNELS.runtimeGetDefaultWsl,
  noRequestSchema,
  z.string().nullable(),
)
export const runtimeSetDefaultWslChannel = channel(
  IPC_CHANNELS.runtimeSetDefaultWsl,
  setDefaultWslDistributionRequestSchema,
  z.string().nullable(),
)
export const runtimeRequireCapabilityChannel = channel(
  IPC_CHANNELS.runtimeRequireCapability,
  requireRuntimePortRequestSchema,
  z.unknown(),
)
export const settingsResolveConfigChannel = channel(
  IPC_CHANNELS.settingsResolveConfig,
  resolveConfigRequestSchema,
  resolvedConfigSchema,
)
export const settingsUpdateConfigChannel = channel(
  IPC_CHANNELS.settingsUpdateConfig,
  updateConfigRequestSchema,
  resolvedConfigSchema,
)
// TASK-088: the Renderer can store/delete/enumerate credential keys, but no
// channel returns a plaintext value.
export const credentialStatusChannel = channel(
  IPC_CHANNELS.credentialStatus,
  noRequestSchema,
  credentialStoreStatusSchema,
)
export const credentialSetChannel = channel(
  IPC_CHANNELS.credentialSet,
  setCredentialRequestSchema,
  voidResponseSchema,
)
export const credentialDeleteChannel = channel(
  IPC_CHANNELS.credentialDelete,
  deleteCredentialRequestSchema,
  z.boolean(),
)
export const credentialListChannel = channel(
  IPC_CHANNELS.credentialList,
  noRequestSchema,
  z.array(z.string()),
)
export const systemOpenDirectoryChannel = channel(
  IPC_CHANNELS.systemOpenDirectory,
  openSystemDirectoryRequestSchema,
  voidResponseSchema,
)
export const doctorRunChannel = channel(
  IPC_CHANNELS.doctorRun,
  runDoctorRequestSchema,
  doctorReportSchema,
)
export const recoveryListChannel = channel(
  IPC_CHANNELS.recoveryList,
  listRecoveryIssuesRequestSchema,
  recoveryReportSchema,
)
export const promptListTemplatesChannel = channel(
  IPC_CHANNELS.promptListTemplates,
  listPromptTemplatesRequestSchema,
  z.array(promptTemplateInfoSchema),
)
export const promptRenderChannel = channel(
  IPC_CHANNELS.promptRender,
  renderPromptTemplateRequestSchema,
  renderedPromptSchema,
)
export const workflowListDefinitionsChannel = channel(
  IPC_CHANNELS.workflowListDefinitions,
  listWorkflowDefinitionsRequestSchema,
  z.array(workflowDefinitionFileInfoSchema),
)
export const workflowLoadDefinitionChannel = channel(
  IPC_CHANNELS.workflowLoadDefinition,
  loadWorkflowDefinitionRequestSchema,
  workflowDefinitionSchema,
)
export const workflowRunListChannel = channel(
  IPC_CHANNELS.workflowRunList,
  listWorkflowRunsRequestSchema,
  z.array(workflowRunSchema),
)
export const workflowRunGetChannel = channel(
  IPC_CHANNELS.workflowRunGet,
  workflowRunIdRequestSchema,
  workflowRunDetailSchema.nullable(),
)
export const workflowRunStartChannel = channel(
  IPC_CHANNELS.workflowRunStart,
  workflowRunStartRequestSchema,
  workflowRunDetailSchema,
)
export const workflowRunCancelChannel = channel(
  IPC_CHANNELS.workflowRunCancel,
  workflowRunIdRequestSchema,
  workflowRunSchema,
)
export const workflowRunCompleteChannel = channel(
  IPC_CHANNELS.workflowRunComplete,
  workflowRunIdRequestSchema,
  workflowRunSchema,
)
export const workflowStepResolveChannel = channel(
  IPC_CHANNELS.workflowStepResolve,
  workflowStepResolveRequestSchema,
  workflowStepSchema,
)
export const workflowShellConfirmationChannel = channel(
  IPC_CHANNELS.workflowShellConfirmation,
  workflowShellConfirmationRequestSchema,
  z.boolean(),
)
export const workflowListPendingShellConfirmationsChannel = channel(
  IPC_CHANNELS.workflowListPendingShellConfirmations,
  listPendingShellConfirmationsRequestSchema,
  z.array(pendingShellConfirmationSchema),
)
export const workflowDispatchChannel = channel(
  IPC_CHANNELS.workflowDispatch,
  workflowDispatchRequestSchema,
  workflowDispatchResultSchema,
)
export const workflowIterateChannel = channel(
  IPC_CHANNELS.workflowIterate,
  workflowIterateRequestSchema,
  workflowIterateResultSchema,
)
export const workflowStartFullChannel = channel(
  IPC_CHANNELS.workflowStartFull,
  startFullWorkflowRequestSchema,
  fullWorkflowStartResultSchema,
)
export const workflowRunSummaryChannel = channel(
  IPC_CHANNELS.workflowRunSummary,
  workflowRunIdRequestSchema,
  fullWorkflowRunSummarySchema,
)

export const ipcChannelDefinitions = {
  ping: pingChannel,
  workspaceCreate: workspaceCreateChannel,
  workspaceOpen: workspaceOpenChannel,
  workspaceRemove: workspaceRemoveChannel,
  workspaceListRecent: workspaceListRecentChannel,
  workspaceValidate: workspaceValidateChannel,
  workspaceSelectDirectory: workspaceSelectDirectoryChannel,
  workspaceUpdateTrust: workspaceUpdateTrustChannel,
  taskCreate: taskCreateChannel,
  taskUpdate: taskUpdateChannel,
  taskArchive: taskArchiveChannel,
  taskDelete: taskDeleteChannel,
  taskGet: taskGetChannel,
  taskList: taskListChannel,
  criteriaListSets: criteriaListSetsChannel,
  criteriaGetSet: criteriaGetSetChannel,
  criteriaCreateSet: criteriaCreateSetChannel,
  criteriaAddCriterion: criteriaAddCriterionChannel,
  criteriaUpdateCriterion: criteriaUpdateCriterionChannel,
  criteriaRemoveCriterion: criteriaRemoveCriterionChannel,
  criteriaConfirmSet: criteriaConfirmSetChannel,
  criteriaSupersedeSet: criteriaSupersedeSetChannel,
  criteriaBindRun: criteriaBindRunChannel,
  artifactRecord: artifactRecordChannel,
  artifactList: artifactListChannel,
  artifactGet: artifactGetChannel,
  artifactScanRun: artifactScanRunChannel,
  handoffGet: handoffGetChannel,
  memoryList: memoryListChannel,
  memoryGet: memoryGetChannel,
  memoryCreate: memoryCreateChannel,
  memoryUpdate: memoryUpdateChannel,
  memoryDelete: memoryDeleteChannel,
  contextPreview: contextPreviewChannel,
  reviewListFindings: reviewListFindingsChannel,
  reviewListCriterionScores: reviewListCriterionScoresChannel,
  reviewPanelStart: reviewPanelStartChannel,
  reviewPanelGet: reviewPanelGetChannel,
  reviewPanelList: reviewPanelListChannel,
  agentListDefinitions: agentListDefinitionsChannel,
  agentDetect: agentDetectChannel,
  agentListDetections: agentListDetectionsChannel,
  agentCheckHealth: agentCheckHealthChannel,
  agentListHealth: agentListHealthChannel,
  agentGetExecutableOverride: agentGetExecutableOverrideChannel,
  agentSetExecutableOverride: agentSetExecutableOverrideChannel,
  agentRunStart: agentRunStartChannel,
  agentRunReviewStart: agentRunReviewStartChannel,
  agentRunSend: agentRunSendChannel,
  agentRunResize: agentRunResizeChannel,
  agentRunCancel: agentRunCancelChannel,
  agentRunGet: agentRunGetChannel,
  agentRunList: agentRunListChannel,
  agentRunOutput: agentRunOutputChannel,
  agentRunResume: agentRunResumeChannel,
  agentRunContinueWithProfile: agentRunContinueWithProfileChannel,
  accountList: accountListChannel,
  accountGet: accountGetChannel,
  accountCreate: accountCreateChannel,
  accountUpdate: accountUpdateChannel,
  accountRemove: accountRemoveChannel,
  accountDetect: accountDetectChannel,
  accountDisable: accountDisableChannel,
  accountEnable: accountEnableChannel,
  accountSetDefault: accountSetDefaultChannel,
  accountLoginStart: accountLoginStartChannel,
  accountLoginWrite: accountLoginWriteChannel,
  accountLoginResize: accountLoginResizeChannel,
  accountLoginCancel: accountLoginCancelChannel,
  accountAliasList: accountAliasListChannel,
  accountAliasBind: accountAliasBindChannel,
  accountAliasUnbind: accountAliasUnbindChannel,
  executionProfileList: executionProfileListChannel,
  executionProfileGet: executionProfileGetChannel,
  executionProfileCreate: executionProfileCreateChannel,
  executionProfileUpdate: executionProfileUpdateChannel,
  executionProfileRemove: executionProfileRemoveChannel,
  executionProfileSetDefault: executionProfileSetDefaultChannel,
  permissionListRules: permissionListRulesChannel,
  permissionCreateRule: permissionCreateRuleChannel,
  permissionUpdateRule: permissionUpdateRuleChannel,
  permissionDeleteRule: permissionDeleteRuleChannel,
  permissionListAudit: permissionListAuditChannel,
  permissionResolveProfile: permissionResolveProfileChannel,
  permissionResolveDecision: permissionResolveDecisionChannel,
  gitStatus: gitStatusChannel,
  gitBranch: gitBranchChannel,
  gitDiff: gitDiffChannel,
  gitLog: gitLogChannel,
  gitCommit: gitCommitChannel,
  gitChanges: gitChangesChannel,
  gitFilePatch: gitFilePatchChannel,
  gitOpenFile: gitOpenFileChannel,
  worktreeCreate: worktreeCreateChannel,
  worktreeList: worktreeListChannel,
  worktreeValidate: worktreeValidateChannel,
  worktreeMergePreflight: worktreeMergePreflightChannel,
  worktreeMerge: worktreeMergeChannel,
  worktreeDiscard: worktreeDiscardChannel,
  worktreeArchive: worktreeArchiveChannel,
  worktreeCleanup: worktreeCleanupChannel,
  maintenanceRetentionPlan: maintenanceRetentionPlanChannel,
  maintenanceRetentionRun: maintenanceRetentionRunChannel,
  maintenanceRetentionCancel: maintenanceRetentionCancelChannel,
  terminalCreate: terminalCreateChannel,
  terminalWrite: terminalWriteChannel,
  terminalResize: terminalResizeChannel,
  terminalClose: terminalCloseChannel,
  terminalGet: terminalGetChannel,
  terminalList: terminalListChannel,
  runtimeInfo: runtimeInfoChannel,
  runtimePaths: runtimePathsChannel,
  runtimeHealth: runtimeHealthChannel,
  runtimeInspectWsl: runtimeInspectWslChannel,
  runtimeListWsl: runtimeListWslChannel,
  runtimeGetDefaultWsl: runtimeGetDefaultWslChannel,
  runtimeSetDefaultWsl: runtimeSetDefaultWslChannel,
  runtimeRequireCapability: runtimeRequireCapabilityChannel,
  settingsResolveConfig: settingsResolveConfigChannel,
  settingsUpdateConfig: settingsUpdateConfigChannel,
  credentialStatus: credentialStatusChannel,
  credentialSet: credentialSetChannel,
  credentialDelete: credentialDeleteChannel,
  credentialList: credentialListChannel,
  systemOpenDirectory: systemOpenDirectoryChannel,
  doctorRun: doctorRunChannel,
  recoveryList: recoveryListChannel,
  promptListTemplates: promptListTemplatesChannel,
  promptRender: promptRenderChannel,
  workflowListDefinitions: workflowListDefinitionsChannel,
  workflowLoadDefinition: workflowLoadDefinitionChannel,
  workflowRunList: workflowRunListChannel,
  workflowRunGet: workflowRunGetChannel,
  workflowRunStart: workflowRunStartChannel,
  workflowRunCancel: workflowRunCancelChannel,
  workflowRunComplete: workflowRunCompleteChannel,
  workflowStepResolve: workflowStepResolveChannel,
  workflowShellConfirmation: workflowShellConfirmationChannel,
  workflowListPendingShellConfirmations: workflowListPendingShellConfirmationsChannel,
  workflowDispatch: workflowDispatchChannel,
  workflowIterate: workflowIterateChannel,
  workflowStartFull: workflowStartFullChannel,
  workflowRunSummary: workflowRunSummaryChannel,
} as const

export interface TeskraBridge {
  readonly appName: 'Teskra'
  readonly appVersion: string
  ping(): Promise<IpcResult<string>>
  readonly workspace: {
    create(request: CreateWorkspaceRequest): Promise<IpcResult<Workspace>>
    open(request: OpenWorkspaceRequest): Promise<IpcResult<Workspace>>
    remove(request: WorkspaceIdRequest): Promise<IpcResult<boolean>>
    listRecent(request?: ListRecentWorkspacesRequest): Promise<IpcResult<Workspace[]>>
    validate(request: OpenWorkspaceRequest): Promise<IpcResult<WorkspaceValidationResult>>
    selectDirectory(request: SelectWorkspaceDirectoryRequest): Promise<IpcResult<string | null>>
    /** TASK-118: flips the workspace trust level (trusted ⇄ restricted). */
    updateTrust(request: UpdateWorkspaceTrustRequest): Promise<IpcResult<Workspace>>
  }
  readonly terminal: {
    create(request: CreateTerminalRequest): Promise<IpcResult<TerminalSession>>
    write(request: TerminalWriteRequest): Promise<IpcResult<void>>
    resize(request: TerminalResizeRequest): Promise<IpcResult<void>>
    close(request: TerminalCloseRequest): Promise<IpcResult<void>>
    get(request: TerminalIdRequest): Promise<IpcResult<TerminalSession | null>>
    list(request?: ListTerminalsRequest): Promise<IpcResult<TerminalSession[]>>
  }
  readonly task: {
    create(request: CreateTaskRequest): Promise<IpcResult<Task>>
    update(request: UpdateTaskRequest): Promise<IpcResult<Task>>
    archive(request: ArchiveTaskRequest): Promise<IpcResult<Task>>
    delete(request: TaskIdRequest): Promise<IpcResult<boolean>>
    get(request: TaskIdRequest): Promise<IpcResult<Task | null>>
    list(request: ListTasksRequest): Promise<IpcResult<Task[]>>
  }
  readonly criteria: {
    listSets(request: ListCriteriaSetsRequest): Promise<IpcResult<AcceptanceCriteriaSet[]>>
    getSet(request: CriteriaSetIdRequest): Promise<IpcResult<AcceptanceCriteriaSetDetail | null>>
    createSet(request: CreateCriteriaSetRequest): Promise<IpcResult<AcceptanceCriteriaSetDetail>>
    addCriterion(request: AddCriterionRequest): Promise<IpcResult<AcceptanceCriterion>>
    updateCriterion(request: UpdateCriterionRequest): Promise<IpcResult<AcceptanceCriterion>>
    removeCriterion(request: CriterionIdRequest): Promise<IpcResult<boolean>>
    confirmSet(request: CriteriaSetIdRequest): Promise<IpcResult<AcceptanceCriteriaSet>>
    supersedeSet(request: CriteriaSetIdRequest): Promise<IpcResult<AcceptanceCriteriaSet>>
    bindRun(request: BindRunCriteriaRequest): Promise<IpcResult<AgentRun>>
  }
  readonly artifact: {
    record(request: RecordArtifactRequest): Promise<IpcResult<Artifact>>
    list(request: ListArtifactsRequest): Promise<IpcResult<Artifact[]>>
    get(request: ArtifactIdRequest): Promise<IpcResult<ArtifactContent | null>>
    scanRun(request: ScanRunArtifactsRequest): Promise<IpcResult<Artifact[]>>
  }
  readonly handoff: {
    get(request: AgentRunIdRequest): Promise<IpcResult<HandoffRecord | null>>
  }
  /** TASK-067: Workspace Memory CRUD; repo-local `file:` memories are read-only. */
  readonly memory: {
    list(request: ListMemoriesRequest): Promise<IpcResult<Memory[]>>
    get(request: MemoryIdRequest): Promise<IpcResult<Memory | null>>
    create(request: CreateMemoryRequest): Promise<IpcResult<Memory>>
    update(request: UpdateMemoryRequest): Promise<IpcResult<Memory | null>>
    delete(request: MemoryIdRequest): Promise<IpcResult<boolean>>
  }
  /** TASK-068: ContextBuilder preview — the packed prompt context for a workspace/task. */
  readonly context: {
    preview(request: BuildContextRequest): Promise<IpcResult<BuiltContext>>
  }
  readonly review: {
    listFindings(request: ListReviewFindingsRequest): Promise<IpcResult<ReviewFindingRecord[]>>
    listCriterionScores(
      request: ListCriterionScoresRequest,
    ): Promise<IpcResult<CriterionScoreRecord[]>>
    startPanel(request: StartReviewPanelRequest): Promise<IpcResult<ReviewPanelResult>>
    getPanel(request: ReviewPanelIdRequest): Promise<IpcResult<ReviewPanelResult | null>>
    listPanels(request: ListReviewPanelsRequest): Promise<IpcResult<ReviewPanel[]>>
  }
  readonly agent: {
    listDefinitions(): Promise<IpcResult<AgentDefinition[]>>
    detect(request: AgentDetectionRequest): Promise<IpcResult<AgentDetectionResult>>
    listDetections(request: ListAgentDetectionsRequest): Promise<IpcResult<AgentDetectionResult[]>>
    checkHealth(request: AgentDetectionRequest): Promise<IpcResult<AgentHealth>>
    listHealth(request: ListAgentDetectionsRequest): Promise<IpcResult<AgentHealth[]>>
    getExecutableOverride(
      request: AgentExecutableOverrideRequest,
    ): Promise<IpcResult<string | null>>
    setExecutableOverride(
      request: SetAgentExecutableOverrideRequest,
    ): Promise<IpcResult<string | null>>
    start(request: StartAgentRunRequest): Promise<IpcResult<AgentRun>>
    startReview(request: StartReviewRunRequest): Promise<IpcResult<ReviewRunStartResult>>
    send(request: SendAgentRunInputRequest): Promise<IpcResult<void>>
    resize(request: ResizeAgentRunRequest): Promise<IpcResult<void>>
    cancel(request: AgentRunIdRequest): Promise<IpcResult<AgentRun>>
    get(request: AgentRunIdRequest): Promise<IpcResult<AgentRun | null>>
    list(request?: ListAgentRunsRequest): Promise<IpcResult<AgentRun[]>>
    getOutput(request: AgentRunOutputRequest): Promise<IpcResult<string>>
    resume(request: ResumeAgentRunRequest): Promise<IpcResult<AgentRun>>
    continueWithProfile(request: ContinueAgentRunRequest): Promise<IpcResult<AgentRun>>
  }
  /**
   * TASK-102 (Milestone 24 §28/§24.2): account profile CRUD + default + detect,
   * and the interactive login session. Login progress streams through the
   * account.login.output / account.login.exited events (subscribe via
   * window.teskra.events). The per-agent default can also be read via
   * settings.resolveConfig (config.agents.defaultAccountProfiles).
   */
  readonly account: {
    list(request?: ListAccountProfilesRequest): Promise<IpcResult<AgentAccountProfile[]>>
    get(request: AccountProfileIdRequest): Promise<IpcResult<AgentAccountProfile | null>>
    create(request: CreateAccountProfileRequest): Promise<IpcResult<AgentAccountProfile>>
    update(request: UpdateAccountProfileRequest): Promise<IpcResult<AgentAccountProfile>>
    /** Soft disable (§47.1); deleteHome additionally removes the managed CLI home. */
    remove(request: RemoveAccountProfileRequest): Promise<IpcResult<AgentAccountProfile>>
    /** Soft disable without touching the CLI home (same lifecycle as remove). */
    disable(request: AccountProfileIdRequest): Promise<IpcResult<AgentAccountProfile>>
    enable(request: AccountProfileIdRequest): Promise<IpcResult<AgentAccountProfile>>
    /** Runs the adapter's status probe and persists the result. */
    detect(request: AccountProfileIdRequest): Promise<IpcResult<AgentAccountProfile>>
    setDefault(request: SetDefaultAccountProfileRequest): Promise<IpcResult<void>>
    /** §24.2: resolves immediately with the session handle — never waits on OAuth. */
    startLogin(request: StartAccountLoginRequest): Promise<IpcResult<AccountLoginSession>>
    writeLogin(request: WriteAccountLoginRequest): Promise<IpcResult<void>>
    resizeLogin(request: ResizeAccountLoginRequest): Promise<IpcResult<void>>
    cancelLogin(request: CancelAccountLoginRequest): Promise<IpcResult<void>>
    /**
     * TASK-111 (§28/§53.1): workflow profile alias bindings. bind validates
     * Main-side that profileId exists in the kind's table and belongs to
     * agentId; unbind returns false when no such binding existed.
     */
    listAliases(request?: ListProfileAliasesRequest): Promise<IpcResult<ProfileAlias[]>>
    bindAlias(request: BindProfileAliasRequest): Promise<IpcResult<ProfileAlias>>
    unbindAlias(request: UnbindProfileAliasRequest): Promise<IpcResult<boolean>>
  }
  /**
   * TASK-110 (Milestone 24 §6.1/§14): execution profile CRUD + per-agent
   * default. Removal is a hard delete (no soft-disable lifecycle — that is
   * account-only, §47.1). The default can also be read via
   * settings.resolveConfig (config.agents.defaultExecutionProfiles).
   */
  readonly executionProfile: {
    list(request?: ListExecutionProfilesRequest): Promise<IpcResult<AgentExecutionProfile[]>>
    get(request: ExecutionProfileIdRequest): Promise<IpcResult<AgentExecutionProfile | null>>
    create(request: CreateExecutionProfileRequest): Promise<IpcResult<AgentExecutionProfile>>
    update(request: UpdateExecutionProfileRequest): Promise<IpcResult<AgentExecutionProfile>>
    remove(request: ExecutionProfileIdRequest): Promise<IpcResult<boolean>>
    setDefault(request: SetDefaultExecutionProfileRequest): Promise<IpcResult<void>>
  }
  readonly permission: {
    listRules(request?: ListPermissionRulesRequest): Promise<IpcResult<PermissionRule[]>>
    createRule(request: CreatePermissionRuleRequest): Promise<IpcResult<PermissionRule>>
    updateRule(request: UpdatePermissionRuleRequest): Promise<IpcResult<PermissionRule | null>>
    deleteRule(request: PermissionRuleIdRequest): Promise<IpcResult<boolean>>
    listAudit(request?: ListPermissionAuditRequest): Promise<IpcResult<PermissionAuditEntry[]>>
    resolveProfile(
      request: ResolvePermissionProfileRequest,
    ): Promise<IpcResult<ResolvedPermissionProfile>>
    resolveDecision(
      request: ResolvePermissionDecisionRequest,
    ): Promise<IpcResult<PermissionDecisionResult>>
  }
  readonly git: {
    status(request: GitWorkspaceRequest): Promise<IpcResult<GitStatus>>
    branch(request: GitWorkspaceRequest): Promise<IpcResult<GitBranch>>
    diff(request: GitDiffRequest): Promise<IpcResult<GitRawDiff>>
    log(request: GitLogRequest): Promise<IpcResult<GitCommit[]>>
    commit(request: GitCommitRequest): Promise<IpcResult<GitCommitResult>>
    changes(request: GitWorkspaceRequest): Promise<IpcResult<DiffResult>>
    filePatch(request: GitFilePatchRequest): Promise<IpcResult<GitRawDiff>>
    openFile(request: GitOpenFileRequest): Promise<IpcResult<void>>
  }
  readonly worktree: {
    create(request: WorktreeCreateRequest): Promise<IpcResult<Worktree>>
    list(request: WorktreeListRequest): Promise<IpcResult<Worktree[]>>
    validate(request: WorktreeIdRequest): Promise<IpcResult<Worktree>>
    preflight(request: WorktreeIdRequest): Promise<IpcResult<MergePreflightResult>>
    merge(request: WorktreeMergeRequest): Promise<IpcResult<WorktreeMergeResult>>
    discard(request: WorktreeDiscardRequest): Promise<IpcResult<Worktree>>
    archive(request: WorktreeIdRequest): Promise<IpcResult<Worktree>>
    cleanup(request: WorktreeCleanupRequest): Promise<IpcResult<WorktreeCleanupResult>>
  }
  readonly maintenance: {
    planRetention(request?: RetentionPlanRequest): Promise<IpcResult<RetentionPlan>>
    runRetention(request?: RetentionRunRequest): Promise<IpcResult<RetentionReport>>
    cancelRetention(): Promise<IpcResult<boolean>>
  }
  readonly runtime: {
    info(): Promise<IpcResult<SystemInfo>>
    paths(): Promise<IpcResult<SystemPaths>>
    health(): Promise<IpcResult<SystemHealth>>
    inspectWsl(): Promise<IpcResult<WslEnvironment>>
    listWslDistributions(): Promise<IpcResult<WslDistribution[]>>
    getDefaultWslDistribution(): Promise<IpcResult<string | null>>
    setDefaultWslDistribution(
      request: SetDefaultWslDistributionRequest,
    ): Promise<IpcResult<string | null>>
    requireCapability(request: RequireRuntimePortRequest): Promise<IpcResult<unknown>>
    doctor(request?: RunDoctorRequest): Promise<IpcResult<DoctorReport>>
  }
  readonly recovery: {
    list(request?: ListRecoveryIssuesRequest): Promise<IpcResult<RecoveryReport>>
  }
  readonly settings: {
    resolveConfig(request?: ResolveConfigRequest): Promise<IpcResult<ResolvedConfig>>
    updateConfig(request: UpdateConfigRequest): Promise<IpcResult<ResolvedConfig>>
    openDirectory(request: OpenSystemDirectoryRequest): Promise<IpcResult<void>>
  }
  readonly credential: {
    status(): Promise<IpcResult<CredentialStoreStatus>>
    set(request: SetCredentialRequest): Promise<IpcResult<void>>
    delete(request: DeleteCredentialRequest): Promise<IpcResult<boolean>>
    /** Key names only — plaintext values never cross into the Renderer. */
    list(): Promise<IpcResult<string[]>>
  }
  readonly prompts: {
    list(request?: ListPromptTemplatesRequest): Promise<IpcResult<PromptTemplateInfo[]>>
    render(request: RenderPromptTemplateRequest): Promise<IpcResult<RenderedPrompt>>
  }
  readonly workflow: {
    listDefinitions(
      request: ListWorkflowDefinitionsRequest,
    ): Promise<IpcResult<WorkflowDefinitionFileInfo[]>>
    loadDefinition(request: LoadWorkflowDefinitionRequest): Promise<IpcResult<WorkflowDefinition>>
    listRuns(request?: ListWorkflowRunsRequest): Promise<IpcResult<WorkflowRun[]>>
    getRun(request: WorkflowRunIdRequest): Promise<IpcResult<WorkflowRunDetail | null>>
    /**
     * P0-4: resolves with the run snapshot as soon as the pass is running;
     * suspended steps do not keep the invoke pending — progress flows through
     * the workflow.run_updated / workflow.step_updated events.
     */
    startRun(request: WorkflowRunStartRequest): Promise<IpcResult<WorkflowRunDetail>>
    cancelRun(request: WorkflowRunIdRequest): Promise<IpcResult<WorkflowRun>>
    /**
     * User-accepts a run parked at needs_user_review (cap reached), closing it
     * as 'completed' — e.g. after reviewing and merging the worktree. Cancel
     * remains the way to abandon one.
     */
    completeRun(request: WorkflowRunIdRequest): Promise<IpcResult<WorkflowRun>>
    resolveStep(request: WorkflowStepResolveRequest): Promise<IpcResult<WorkflowStep>>
    /**
     * TASK-118: approves or rejects a shell step parked on
     * workflow.shell_confirmation_required (true = it was awaiting a decision).
     */
    confirmShellStep(request: WorkflowShellConfirmationRequest): Promise<IpcResult<boolean>>
    /**
     * Code-review P1-6: parked shell confirmations survive a renderer reload;
     * the confirmation host pulls this list on (re)subscribe instead of
     * relying on having seen the live event.
     */
    listPendingShellConfirmations(
      request?: ListPendingShellConfirmationsRequest,
    ): Promise<IpcResult<PendingShellConfirmation[]>>
    dispatch(request: WorkflowDispatchRequest): Promise<IpcResult<WorkflowDispatchResult>>
    iterate(request: WorkflowIterateRequest): Promise<IpcResult<WorkflowIterateResult>>
    startFullWorkflow(
      request: StartFullWorkflowRequest,
    ): Promise<IpcResult<FullWorkflowStartResult>>
    runSummary(request: WorkflowRunIdRequest): Promise<IpcResult<FullWorkflowRunSummary>>
  }
  readonly events: {
    subscribe<Name extends WorkbenchEventName>(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}
