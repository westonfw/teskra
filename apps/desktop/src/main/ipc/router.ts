import { ipcChannelDefinitions, type IpcChannelDefinition, type IpcResult } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from '../errors'
import { requireRuntimePort, type TeskraRuntime } from '../runtime/facade'

export interface IpcMainPort {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

export interface IpcRouter {
  dispose(): void
}

type MaybePromise<T> = T | Promise<T>

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function runtimeUnavailable<T>(): IpcResult<T> {
  return fail({
    code: 'CAPABILITY_NOT_AVAILABLE',
    message: 'Teskra Runtime is not available.',
    retryable: true,
    detail: 'IPC request arrived before runtime composition completed or after disposal',
  })
}

/** Registers every channel from the shared registry exactly once (TASK-020). */
export function registerIpcRouter(
  ipc: IpcMainPort,
  getRuntime: () => TeskraRuntime | undefined,
): IpcRouter {
  const registered: string[] = []

  const register = <Req, Res>(
    definition: IpcChannelDefinition<Req, Res>,
    operation: (runtime: TeskraRuntime | undefined, request: Req) => MaybePromise<IpcResult<Res>>,
  ): void => {
    ipc.handle(definition.channel, async (_event, payload) => {
      const request = definition.request.safeParse(payload)
      if (!request.success) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Invalid request for IPC channel "${definition.channel}".`,
          retryable: false,
          detail: JSON.stringify(request.error.issues),
        })
      }

      let result: IpcResult<Res>
      try {
        result = await operation(getRuntime(), request.data)
      } catch (cause) {
        result = fail({
          code: 'UNKNOWN',
          message: `IPC operation "${definition.channel}" failed unexpectedly.`,
          retryable: true,
          detail: 'Facade method threw instead of returning IpcResult',
          cause,
        })
      }

      const response = definition.response.safeParse(result)
      if (!response.success) {
        return fail({
          code: 'UNKNOWN',
          message: `IPC operation "${definition.channel}" returned an invalid response.`,
          retryable: false,
          detail: JSON.stringify(response.error.issues),
        })
      }
      return response.data
    })
    registered.push(definition.channel)
  }

  const withRuntime =
    <Req, Res>(operation: (runtime: TeskraRuntime, request: Req) => MaybePromise<IpcResult<Res>>) =>
    (runtime: TeskraRuntime | undefined, request: Req): MaybePromise<IpcResult<Res>> =>
      runtime === undefined ? runtimeUnavailable() : operation(runtime, request)

  register(ipcChannelDefinitions.ping, () => ({ ok: true, data: 'pong' }))
  register(
    ipcChannelDefinitions.workspaceCreate,
    withRuntime((runtime, request) => runtime.workspace.create(request)),
  )
  register(
    ipcChannelDefinitions.workspaceOpen,
    withRuntime((runtime, request) => runtime.workspace.open(request)),
  )
  register(
    ipcChannelDefinitions.workspaceRemove,
    withRuntime((runtime, request) => runtime.workspace.remove(request)),
  )
  register(
    ipcChannelDefinitions.workspaceListRecent,
    withRuntime((runtime, request) => runtime.workspace.listRecent(request)),
  )
  register(
    ipcChannelDefinitions.workspaceValidate,
    withRuntime((runtime, request) => runtime.workspace.validate(request)),
  )
  register(
    ipcChannelDefinitions.workspaceSelectDirectory,
    withRuntime((runtime, request) => runtime.workspace.selectDirectory(request)),
  )
  register(
    ipcChannelDefinitions.taskCreate,
    withRuntime((runtime, request) => runtime.task.create(request)),
  )
  register(
    ipcChannelDefinitions.taskUpdate,
    withRuntime((runtime, request) => runtime.task.update(request)),
  )
  register(
    ipcChannelDefinitions.taskArchive,
    withRuntime((runtime, request) => runtime.task.archive(request)),
  )
  register(
    ipcChannelDefinitions.taskDelete,
    withRuntime((runtime, request) => runtime.task.delete(request)),
  )
  register(
    ipcChannelDefinitions.taskGet,
    withRuntime((runtime, request) => runtime.task.get(request)),
  )
  register(
    ipcChannelDefinitions.taskList,
    withRuntime((runtime, request) => runtime.task.list(request)),
  )
  register(
    ipcChannelDefinitions.agentListDefinitions,
    withRuntime((runtime) => runtime.agent.listDefinitions()),
  )
  register(
    ipcChannelDefinitions.agentDetect,
    withRuntime((runtime, request) => runtime.agent.detect(request)),
  )
  register(
    ipcChannelDefinitions.agentListDetections,
    withRuntime((runtime, request) => runtime.agent.listDetections(request)),
  )
  register(
    ipcChannelDefinitions.agentCheckHealth,
    withRuntime((runtime, request) => runtime.agent.checkHealth(request)),
  )
  register(
    ipcChannelDefinitions.agentListHealth,
    withRuntime((runtime, request) => runtime.agent.listHealth(request)),
  )
  register(
    ipcChannelDefinitions.agentGetExecutableOverride,
    withRuntime((runtime, request) => runtime.agent.getExecutableOverride(request)),
  )
  register(
    ipcChannelDefinitions.agentSetExecutableOverride,
    withRuntime((runtime, request) => runtime.agent.setExecutableOverride(request)),
  )
  register(
    ipcChannelDefinitions.agentRunStart,
    withRuntime((runtime, request) => runtime.agent.start(request)),
  )
  register(
    ipcChannelDefinitions.agentRunSend,
    withRuntime((runtime, request) => runtime.agent.send(request)),
  )
  register(
    ipcChannelDefinitions.agentRunCancel,
    withRuntime((runtime, request) => runtime.agent.cancel(request)),
  )
  register(
    ipcChannelDefinitions.agentRunGet,
    withRuntime((runtime, request) => runtime.agent.get(request)),
  )
  register(
    ipcChannelDefinitions.agentRunList,
    withRuntime((runtime, request) => runtime.agent.list(request)),
  )
  register(
    ipcChannelDefinitions.agentRunOutput,
    withRuntime((runtime, request) => runtime.agent.getOutput(request)),
  )
  register(
    ipcChannelDefinitions.gitStatus,
    withRuntime((runtime, request) => runtime.git.status(request)),
  )
  register(
    ipcChannelDefinitions.gitBranch,
    withRuntime((runtime, request) => runtime.git.branch(request)),
  )
  register(
    ipcChannelDefinitions.gitDiff,
    withRuntime((runtime, request) => runtime.git.diff(request)),
  )
  register(
    ipcChannelDefinitions.gitLog,
    withRuntime((runtime, request) => runtime.git.log(request)),
  )
  register(
    ipcChannelDefinitions.gitCommit,
    withRuntime((runtime, request) => runtime.git.commit(request)),
  )
  register(
    ipcChannelDefinitions.gitChanges,
    withRuntime((runtime, request) => runtime.git.changes(request)),
  )
  register(
    ipcChannelDefinitions.gitOpenFile,
    withRuntime((runtime, request) => runtime.git.openFile(request)),
  )
  register(
    ipcChannelDefinitions.terminalCreate,
    withRuntime((runtime, request) => runtime.terminal.create(request)),
  )
  register(
    ipcChannelDefinitions.terminalWrite,
    withRuntime((runtime, request) => runtime.terminal.write(request)),
  )
  register(
    ipcChannelDefinitions.terminalResize,
    withRuntime((runtime, request) => runtime.terminal.resize(request)),
  )
  register(
    ipcChannelDefinitions.terminalClose,
    withRuntime((runtime, request) => runtime.terminal.close(request)),
  )
  register(
    ipcChannelDefinitions.terminalGet,
    withRuntime((runtime, request) => runtime.terminal.get(request)),
  )
  register(
    ipcChannelDefinitions.terminalList,
    withRuntime((runtime, request) => runtime.terminal.list(request)),
  )
  register(
    ipcChannelDefinitions.runtimeInfo,
    withRuntime((runtime) => runtime.system.info()),
  )
  register(
    ipcChannelDefinitions.runtimePaths,
    withRuntime((runtime) => runtime.system.paths()),
  )
  register(
    ipcChannelDefinitions.runtimeHealth,
    withRuntime((runtime) => runtime.system.health()),
  )
  register(
    ipcChannelDefinitions.runtimeInspectWsl,
    withRuntime((runtime) => runtime.system.inspectWsl()),
  )
  register(
    ipcChannelDefinitions.runtimeListWsl,
    withRuntime((runtime) => runtime.system.listWslDistributions()),
  )
  register(
    ipcChannelDefinitions.runtimeGetDefaultWsl,
    withRuntime((runtime) => runtime.system.getDefaultWslDistribution()),
  )
  register(
    ipcChannelDefinitions.runtimeSetDefaultWsl,
    withRuntime((runtime, request) => runtime.system.setDefaultWslDistribution(request.name)),
  )
  register(
    ipcChannelDefinitions.runtimeRequireCapability,
    withRuntime((runtime, request) => requireRuntimePort(runtime, request.name)),
  )
  register(
    ipcChannelDefinitions.doctorRun,
    withRuntime((runtime, request) => runtime.system.doctor(request)),
  )
  register(
    ipcChannelDefinitions.settingsResolveConfig,
    withRuntime((runtime, request) => runtime.settings.resolveConfig(request)),
  )
  register(
    ipcChannelDefinitions.settingsUpdateConfig,
    withRuntime((runtime, request) => runtime.settings.updateConfig(request)),
  )
  register(
    ipcChannelDefinitions.systemOpenDirectory,
    withRuntime((runtime, request) => runtime.settings.openDirectory(request)),
  )

  return {
    dispose() {
      for (const channel of registered.splice(0)) {
        ipc.removeHandler(channel)
      }
    },
  }
}
