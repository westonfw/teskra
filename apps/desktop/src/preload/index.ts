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
  task: {
    create: (request) => invoke(IPC_CHANNELS.taskCreate, request),
    update: (request) => invoke(IPC_CHANNELS.taskUpdate, request),
    archive: (request) => invoke(IPC_CHANNELS.taskArchive, request),
    delete: (request) => invoke(IPC_CHANNELS.taskDelete, request),
    get: (request) => invoke(IPC_CHANNELS.taskGet, request),
    list: (request) => invoke(IPC_CHANNELS.taskList, request),
  },
  criteria: {
    listSets: (request) => invoke(IPC_CHANNELS.criteriaListSets, request),
    getSet: (request) => invoke(IPC_CHANNELS.criteriaGetSet, request),
    createSet: (request) => invoke(IPC_CHANNELS.criteriaCreateSet, request),
    addCriterion: (request) => invoke(IPC_CHANNELS.criteriaAddCriterion, request),
    updateCriterion: (request) => invoke(IPC_CHANNELS.criteriaUpdateCriterion, request),
    removeCriterion: (request) => invoke(IPC_CHANNELS.criteriaRemoveCriterion, request),
    confirmSet: (request) => invoke(IPC_CHANNELS.criteriaConfirmSet, request),
    supersedeSet: (request) => invoke(IPC_CHANNELS.criteriaSupersedeSet, request),
    bindRun: (request) => invoke(IPC_CHANNELS.criteriaBindRun, request),
  },
  artifact: {
    record: (request) => invoke(IPC_CHANNELS.artifactRecord, request),
    list: (request) => invoke(IPC_CHANNELS.artifactList, request),
    get: (request) => invoke(IPC_CHANNELS.artifactGet, request),
    scanRun: (request) => invoke(IPC_CHANNELS.artifactScanRun, request),
  },
  handoff: {
    get: (request) => invoke(IPC_CHANNELS.handoffGet, request),
  },
  terminal: {
    create: (request) => invoke(IPC_CHANNELS.terminalCreate, request),
    write: (request) => invoke(IPC_CHANNELS.terminalWrite, request),
    resize: (request) => invoke(IPC_CHANNELS.terminalResize, request),
    close: (request) => invoke(IPC_CHANNELS.terminalClose, request),
    get: (request) => invoke(IPC_CHANNELS.terminalGet, request),
    list: (request = {}) => invoke(IPC_CHANNELS.terminalList, request),
  },
  agent: {
    listDefinitions: () => invoke(IPC_CHANNELS.agentListDefinitions),
    detect: (request) => invoke(IPC_CHANNELS.agentDetect, request),
    listDetections: (request) => invoke(IPC_CHANNELS.agentListDetections, request),
    checkHealth: (request) => invoke(IPC_CHANNELS.agentCheckHealth, request),
    listHealth: (request) => invoke(IPC_CHANNELS.agentListHealth, request),
    getExecutableOverride: (request) => invoke(IPC_CHANNELS.agentGetPathOverride, request),
    setExecutableOverride: (request) => invoke(IPC_CHANNELS.agentSetPathOverride, request),
    start: (request) => invoke(IPC_CHANNELS.agentRunStart, request),
    resume: (request) => invoke(IPC_CHANNELS.agentRunResume, request),
    send: (request) => invoke(IPC_CHANNELS.agentRunSend, request),
    cancel: (request) => invoke(IPC_CHANNELS.agentRunCancel, request),
    get: (request) => invoke(IPC_CHANNELS.agentRunGet, request),
    list: (request = {}) => invoke(IPC_CHANNELS.agentRunList, request),
    getOutput: (request) => invoke(IPC_CHANNELS.agentRunOutput, request),
  },
  git: {
    status: (request) => invoke(IPC_CHANNELS.gitStatus, request),
    branch: (request) => invoke(IPC_CHANNELS.gitBranch, request),
    diff: (request) => invoke(IPC_CHANNELS.gitDiff, request),
    log: (request) => invoke(IPC_CHANNELS.gitLog, request),
    commit: (request) => invoke(IPC_CHANNELS.gitCommit, request),
    changes: (request) => invoke(IPC_CHANNELS.gitChanges, request),
    openFile: (request) => invoke(IPC_CHANNELS.gitOpenFile, request),
  },
  worktree: {
    create: (request) => invoke(IPC_CHANNELS.worktreeCreate, request),
    list: (request) => invoke(IPC_CHANNELS.worktreeList, request),
    validate: (request) => invoke(IPC_CHANNELS.worktreeValidate, request),
    preflight: (request) => invoke(IPC_CHANNELS.worktreeMergePreflight, request),
    merge: (request) => invoke(IPC_CHANNELS.worktreeMerge, request),
    discard: (request) => invoke(IPC_CHANNELS.worktreeDiscard, request),
    archive: (request) => invoke(IPC_CHANNELS.worktreeArchive, request),
    cleanup: (request) => invoke(IPC_CHANNELS.worktreeCleanup, request),
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
    doctor: (request = {}) => invoke(IPC_CHANNELS.doctorRun, request),
  },
  settings: {
    resolveConfig: (request = {}) => invoke(IPC_CHANNELS.settingsResolveConfig, request),
    updateConfig: (request) => invoke(IPC_CHANNELS.settingsUpdateConfig, request),
    openDirectory: (request) => invoke(IPC_CHANNELS.systemOpenDirectory, request),
  },
  prompts: {
    list: (request = {}) => invoke(IPC_CHANNELS.promptListTemplates, request),
    render: (request) => invoke(IPC_CHANNELS.promptRender, request),
  },
  events: eventSubscriptions,
}

contextBridge.exposeInMainWorld('teskra', bridge)
