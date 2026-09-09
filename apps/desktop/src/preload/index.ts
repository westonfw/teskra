import { contextBridge, ipcRenderer } from 'electron'

import {
  IPC_CHANNELS,
  RENDERER_EVENT_CHANNEL,
  type IpcResult,
  type TeskraBridge,
  type WorkbenchEventEnvelope,
} from '@teskra/contracts'
import { createRendererEventSubscriptions } from './event-subscriptions'

// The preload bundle is self-contained under sandbox:true. Renderer code gets
// domain methods only — never ipcRenderer and never a generic exec(channel).
function invoke<Result>(channel: string, payload?: unknown): Promise<IpcResult<Result>> {
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResult<Result>>
}

const eventSubscriptions = createRendererEventSubscriptions((listener) => {
  const ipcListener = (_event: unknown, envelope: WorkbenchEventEnvelope): void =>
    listener(envelope)
  ipcRenderer.on(RENDERER_EVENT_CHANNEL, ipcListener)
  return () => ipcRenderer.removeListener(RENDERER_EVENT_CHANNEL, ipcListener)
})

const bridge: TeskraBridge = {
  appName: 'Teskra',
  appVersion: '0.1.0',
  ping: () => invoke(IPC_CHANNELS.ping),
  workspace: {
    create: (request) => invoke(IPC_CHANNELS.workspaceCreate, request),
    open: (request) => invoke(IPC_CHANNELS.workspaceOpen, request),
    remove: (request) => invoke(IPC_CHANNELS.workspaceRemove, request),
    listRecent: (request = {}) => invoke(IPC_CHANNELS.workspaceListRecent, request),
    validate: (request) => invoke(IPC_CHANNELS.workspaceValidate, request),
    selectDirectory: (request) => invoke(IPC_CHANNELS.workspaceSelectDirectory, request),
  },
  terminal: {
    create: (request) => invoke(IPC_CHANNELS.terminalCreate, request),
    write: (request) => invoke(IPC_CHANNELS.terminalWrite, request),
    resize: (request) => invoke(IPC_CHANNELS.terminalResize, request),
    close: (request) => invoke(IPC_CHANNELS.terminalClose, request),
    get: (request) => invoke(IPC_CHANNELS.terminalGet, request),
    list: (request = {}) => invoke(IPC_CHANNELS.terminalList, request),
  },
  runtime: {
    info: () => invoke(IPC_CHANNELS.runtimeInfo),
    paths: () => invoke(IPC_CHANNELS.runtimePaths),
    health: () => invoke(IPC_CHANNELS.runtimeHealth),
    inspectWsl: () => invoke(IPC_CHANNELS.runtimeInspectWsl),
    listWslDistributions: () => invoke(IPC_CHANNELS.runtimeListWsl),
    getDefaultWslDistribution: () => invoke(IPC_CHANNELS.runtimeGetDefaultWsl),
    setDefaultWslDistribution: (request) => invoke(IPC_CHANNELS.runtimeSetDefaultWsl, request),
    requireCapability: (request) => invoke(IPC_CHANNELS.runtimeRequireCapability, request),
  },
  settings: {
    resolveConfig: (request = {}) => invoke(IPC_CHANNELS.settingsResolveConfig, request),
    updateConfig: (request) => invoke(IPC_CHANNELS.settingsUpdateConfig, request),
    openDirectory: (request) => invoke(IPC_CHANNELS.systemOpenDirectory, request),
  },
  events: eventSubscriptions,
}

contextBridge.exposeInMainWorld('teskra', bridge)
