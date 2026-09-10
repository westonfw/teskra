import { z } from 'zod'

import {
  agentDefinitionSchema,
  agentDetectionRequestSchema,
  agentDetectionResultSchema,
  agentRunIdRequestSchema,
  agentRunSchema,
  agentHealthSchema,
  agentExecutableOverrideRequestSchema,
  listAgentDetectionsRequestSchema,
  listAgentRunsRequestSchema,
  resumeAgentRunRequestSchema,
  sendAgentRunInputRequestSchema,
  setAgentExecutableOverrideRequestSchema,
  startAgentRunRequestSchema,
  type AgentDefinition,
  type AgentDetectionRequest,
  type AgentDetectionResult,
  type AgentRun,
  type AgentRunIdRequest,
  type AgentHealth,
  type AgentExecutableOverrideRequest,
  type ListAgentDetectionsRequest,
  type ListAgentRunsRequest,
  type ResumeAgentRunRequest,
  type SendAgentRunInputRequest,
  type SetAgentExecutableOverrideRequest,
  type StartAgentRunRequest,
} from './agent'
import { ipcResultSchema, type IpcResult } from './error'
import {
  doctorReportSchema,
  runDoctorRequestSchema,
  type DoctorReport,
  type RunDoctorRequest,
} from './doctor'
import type { WorkbenchEventName, WorkbenchEvents } from './event'
import {
  diffResultSchema,
  gitBranchSchema,
  gitCommitRequestSchema,
  gitCommitResultSchema,
  gitCommitSchema,
  gitDiffRequestSchema,
  gitLogRequestSchema,
  gitOpenFileRequestSchema,
  gitRawDiffSchema,
  gitStatusSchema,
  gitWorkspaceRequestSchema,
  mergePreflightResultSchema,
  worktreeCreateRequestSchema,
  worktreeIdRequestSchema,
  worktreeListRequestSchema,
  worktreeSchema,
  type DiffResult,
  type GitBranch,
  type GitCommit,
  type GitCommitRequest,
  type GitCommitResult,
  type GitDiffRequest,
  type GitLogRequest,
  type GitOpenFileRequest,
  type GitRawDiff,
  type GitStatus,
  type GitWorkspaceRequest,
  type MergePreflightResult,
  type Worktree,
  type WorktreeCreateRequest,
  type WorktreeIdRequest,
  type WorktreeListRequest,
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
  workspaceIdRequestSchema,
  workspaceSchema,
  workspaceValidationSchema,
  type CreateWorkspaceRequest,
  type ListRecentWorkspacesRequest,
  type OpenWorkspaceRequest,
  type SelectWorkspaceDirectoryRequest,
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

export const IPC_CHANNELS = {
  ping: 'teskra:ping',
  workspaceCreate: 'teskra:workspace:create',
  workspaceOpen: 'teskra:workspace:open',
  workspaceRemove: 'teskra:workspace:remove',
  workspaceListRecent: 'teskra:workspace:list-recent',
  workspaceValidate: 'teskra:workspace:validate',
  workspaceSelectDirectory: 'teskra:workspace:select-directory',
  taskCreate: 'teskra:task:create',
  taskUpdate: 'teskra:task:update',
  taskArchive: 'teskra:task:archive',
  taskDelete: 'teskra:task:delete',
  taskGet: 'teskra:task:get',
  taskList: 'teskra:task:list',
  agentListDefinitions: 'teskra:agent:list-definitions',
  agentDetect: 'teskra:agent:detect',
  agentListDetections: 'teskra:agent:list-detections',
  agentCheckHealth: 'teskra:agent:health:check',
  agentListHealth: 'teskra:agent:health:list',
  agentGetPathOverride: 'teskra:agent:path-override:get',
  agentSetPathOverride: 'teskra:agent:path-override:set',
  agentRunStart: 'teskra:agent-run:start',
  agentRunSend: 'teskra:agent-run:send',
  agentRunCancel: 'teskra:agent-run:cancel',
  agentRunGet: 'teskra:agent-run:get',
  agentRunList: 'teskra:agent-run:list',
  agentRunOutput: 'teskra:agent-run:output',
  agentRunResume: 'teskra:agent-run:resume',
  gitStatus: 'teskra:git:status',
  gitBranch: 'teskra:git:branch',
  gitDiff: 'teskra:git:diff',
  gitLog: 'teskra:git:log',
  gitCommit: 'teskra:git:commit',
  gitChanges: 'teskra:git:changes',
  gitOpenFile: 'teskra:git:open-file',
  worktreeCreate: 'teskra:worktree:create',
  worktreeList: 'teskra:worktree:list',
  worktreeValidate: 'teskra:worktree:validate',
  worktreeMergePreflight: 'teskra:worktree:preflight',
  worktreeRemove: 'teskra:worktree:remove',
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
  systemOpenDirectory: 'teskra:system:directory:open',
  doctorRun: 'teskra:doctor:run',
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
export const agentRunSendChannel = channel(
  IPC_CHANNELS.agentRunSend,
  sendAgentRunInputRequestSchema,
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
  agentRunIdRequestSchema,
  z.string(),
)
export const agentRunResumeChannel = channel(
  IPC_CHANNELS.agentRunResume,
  resumeAgentRunRequestSchema,
  agentRunSchema,
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
export const worktreeRemoveChannel = channel(
  IPC_CHANNELS.worktreeRemove,
  worktreeIdRequestSchema,
  worktreeSchema,
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

export const ipcChannelDefinitions = {
  ping: pingChannel,
  workspaceCreate: workspaceCreateChannel,
  workspaceOpen: workspaceOpenChannel,
  workspaceRemove: workspaceRemoveChannel,
  workspaceListRecent: workspaceListRecentChannel,
  workspaceValidate: workspaceValidateChannel,
  workspaceSelectDirectory: workspaceSelectDirectoryChannel,
  taskCreate: taskCreateChannel,
  taskUpdate: taskUpdateChannel,
  taskArchive: taskArchiveChannel,
  taskDelete: taskDeleteChannel,
  taskGet: taskGetChannel,
  taskList: taskListChannel,
  agentListDefinitions: agentListDefinitionsChannel,
  agentDetect: agentDetectChannel,
  agentListDetections: agentListDetectionsChannel,
  agentCheckHealth: agentCheckHealthChannel,
  agentListHealth: agentListHealthChannel,
  agentGetExecutableOverride: agentGetExecutableOverrideChannel,
  agentSetExecutableOverride: agentSetExecutableOverrideChannel,
  agentRunStart: agentRunStartChannel,
  agentRunSend: agentRunSendChannel,
  agentRunCancel: agentRunCancelChannel,
  agentRunGet: agentRunGetChannel,
  agentRunList: agentRunListChannel,
  agentRunOutput: agentRunOutputChannel,
  agentRunResume: agentRunResumeChannel,
  gitStatus: gitStatusChannel,
  gitBranch: gitBranchChannel,
  gitDiff: gitDiffChannel,
  gitLog: gitLogChannel,
  gitCommit: gitCommitChannel,
  gitChanges: gitChangesChannel,
  gitOpenFile: gitOpenFileChannel,
  worktreeCreate: worktreeCreateChannel,
  worktreeList: worktreeListChannel,
  worktreeValidate: worktreeValidateChannel,
  worktreeMergePreflight: worktreeMergePreflightChannel,
  worktreeRemove: worktreeRemoveChannel,
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
  systemOpenDirectory: systemOpenDirectoryChannel,
  doctorRun: doctorRunChannel,
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
    send(request: SendAgentRunInputRequest): Promise<IpcResult<void>>
    cancel(request: AgentRunIdRequest): Promise<IpcResult<AgentRun>>
    get(request: AgentRunIdRequest): Promise<IpcResult<AgentRun | null>>
    list(request?: ListAgentRunsRequest): Promise<IpcResult<AgentRun[]>>
    getOutput(request: AgentRunIdRequest): Promise<IpcResult<string>>
    resume(request: ResumeAgentRunRequest): Promise<IpcResult<AgentRun>>
  }
  readonly git: {
    status(request: GitWorkspaceRequest): Promise<IpcResult<GitStatus>>
    branch(request: GitWorkspaceRequest): Promise<IpcResult<GitBranch>>
    diff(request: GitDiffRequest): Promise<IpcResult<GitRawDiff>>
    log(request: GitLogRequest): Promise<IpcResult<GitCommit[]>>
    commit(request: GitCommitRequest): Promise<IpcResult<GitCommitResult>>
    changes(request: GitWorkspaceRequest): Promise<IpcResult<DiffResult>>
    openFile(request: GitOpenFileRequest): Promise<IpcResult<void>>
  }
  readonly worktree: {
    create(request: WorktreeCreateRequest): Promise<IpcResult<Worktree>>
    list(request: WorktreeListRequest): Promise<IpcResult<Worktree[]>>
    validate(request: WorktreeIdRequest): Promise<IpcResult<Worktree>>
    preflight(request: WorktreeIdRequest): Promise<IpcResult<MergePreflightResult>>
    remove(request: WorktreeIdRequest): Promise<IpcResult<Worktree>>
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
  readonly settings: {
    resolveConfig(request?: ResolveConfigRequest): Promise<IpcResult<ResolvedConfig>>
    updateConfig(request: UpdateConfigRequest): Promise<IpcResult<ResolvedConfig>>
    openDirectory(request: OpenSystemDirectoryRequest): Promise<IpcResult<void>>
  }
  readonly events: {
    subscribe<Name extends WorkbenchEventName>(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}
