import { z } from 'zod'

import { ipcResultSchema, type IpcResult } from './error'
import type { WorkbenchEventName, WorkbenchEvents } from './event'
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

export const ipcChannelDefinitions = {
  ping: pingChannel,
  workspaceCreate: workspaceCreateChannel,
  workspaceOpen: workspaceOpenChannel,
  workspaceRemove: workspaceRemoveChannel,
  workspaceListRecent: workspaceListRecentChannel,
  workspaceValidate: workspaceValidateChannel,
  workspaceSelectDirectory: workspaceSelectDirectoryChannel,
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
