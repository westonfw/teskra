import type {
  CreateTerminalRequest,
  CreateWorkspaceRequest,
  FutureRuntimePortName,
  IpcResult,
  ListRecentWorkspacesRequest,
  ListTerminalsRequest,
  OpenWorkspaceRequest,
  OpenSystemDirectoryRequest,
  ResolveConfigRequest,
  ResolvedConfig,
  SelectWorkspaceDirectoryRequest,
  SystemHealth,
  SystemInfo,
  SystemPaths,
  TerminalCloseRequest,
  TerminalIdRequest,
  TerminalResizeRequest,
  TerminalSession,
  TerminalWriteRequest,
  UpdateConfigRequest,
  Workspace,
  WorkspaceIdRequest,
  WorkspaceValidationResult,
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
}

export interface SettingsPort {
  resolveConfig(request?: ResolveConfigRequest): IpcResult<ResolvedConfig>
  updateConfig(request: UpdateConfigRequest): IpcResult<ResolvedConfig>
  openDirectory(request: OpenSystemDirectoryRequest): Promise<IpcResult<void>>
}

export type FutureRuntimePort = Record<string, never>

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
  readonly task?: FutureRuntimePort
  readonly agent?: FutureRuntimePort
  readonly git?: FutureRuntimePort
  readonly worktree?: FutureRuntimePort
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
