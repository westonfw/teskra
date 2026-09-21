import { contextBridge, ipcRenderer } from 'electron'

import {
  IPC_CHANNELS,
  RENDERER_EVENT_CHANNEL,
  type IpcResult,
  type TeskraBridge,
  type WorkbenchEventEnvelope,
} from '@teskra/contracts'
import { createRendererEventSubscriptions } from './event-subscriptions'
import { APP_VERSION } from '../main/build-info'

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
  appVersion: APP_VERSION,
  ping: () => invoke(IPC_CHANNELS.ping),
  openExternal: (request) => invoke(IPC_CHANNELS.appOpenExternal, request),
  workspace: {
    create: (request) => invoke(IPC_CHANNELS.workspaceCreate, request),
    open: (request) => invoke(IPC_CHANNELS.workspaceOpen, request),
    remove: (request) => invoke(IPC_CHANNELS.workspaceRemove, request),
    listRecent: (request = {}) => invoke(IPC_CHANNELS.workspaceListRecent, request),
    validate: (request) => invoke(IPC_CHANNELS.workspaceValidate, request),
    selectDirectory: (request) => invoke(IPC_CHANNELS.workspaceSelectDirectory, request),
    updateTrust: (request) => invoke(IPC_CHANNELS.workspaceUpdateTrust, request),
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
  memory: {
    list: (request) => invoke(IPC_CHANNELS.memoryList, request),
    get: (request) => invoke(IPC_CHANNELS.memoryGet, request),
    create: (request) => invoke(IPC_CHANNELS.memoryCreate, request),
    update: (request) => invoke(IPC_CHANNELS.memoryUpdate, request),
    delete: (request) => invoke(IPC_CHANNELS.memoryDelete, request),
  },
  context: {
    preview: (request) => invoke(IPC_CHANNELS.contextPreview, request),
  },
  review: {
    listFindings: (request) => invoke(IPC_CHANNELS.reviewListFindings, request),
    listCriterionScores: (request) => invoke(IPC_CHANNELS.reviewListCriterionScores, request),
    startPanel: (request) => invoke(IPC_CHANNELS.reviewPanelStart, request),
    getPanel: (request) => invoke(IPC_CHANNELS.reviewPanelGet, request),
    listPanels: (request) => invoke(IPC_CHANNELS.reviewPanelList, request),
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
    startReview: (request) => invoke(IPC_CHANNELS.agentRunReviewStart, request),
    resume: (request) => invoke(IPC_CHANNELS.agentRunResume, request),
    continueWithProfile: (request) => invoke(IPC_CHANNELS.agentRunContinueWithProfile, request),
    send: (request) => invoke(IPC_CHANNELS.agentRunSend, request),
    resize: (request) => invoke(IPC_CHANNELS.agentRunResize, request),
    cancel: (request) => invoke(IPC_CHANNELS.agentRunCancel, request),
    get: (request) => invoke(IPC_CHANNELS.agentRunGet, request),
    list: (request = {}) => invoke(IPC_CHANNELS.agentRunList, request),
    getOutput: (request) => invoke(IPC_CHANNELS.agentRunOutput, request),
    listProgress: (request) => invoke(IPC_CHANNELS.agentListProgress, request),
    listObservations: (request) => invoke(IPC_CHANNELS.agentListObservations, request),
  },
  account: {
    list: (request = {}) => invoke(IPC_CHANNELS.accountList, request),
    listAdapterAgents: (request = {}) => invoke(IPC_CHANNELS.accountListAdapterAgents, request),
    listRateLimitStats: (request = {}) => invoke(IPC_CHANNELS.accountListRateLimitStats, request),
    get: (request) => invoke(IPC_CHANNELS.accountGet, request),
    create: (request) => invoke(IPC_CHANNELS.accountCreate, request),
    update: (request) => invoke(IPC_CHANNELS.accountUpdate, request),
    remove: (request) => invoke(IPC_CHANNELS.accountRemove, request),
    disable: (request) => invoke(IPC_CHANNELS.accountDisable, request),
    enable: (request) => invoke(IPC_CHANNELS.accountEnable, request),
    detect: (request) => invoke(IPC_CHANNELS.accountDetect, request),
    setDefault: (request) => invoke(IPC_CHANNELS.accountSetDefault, request),
    startLogin: (request) => invoke(IPC_CHANNELS.accountLoginStart, request),
    writeLogin: (request) => invoke(IPC_CHANNELS.accountLoginWrite, request),
    resizeLogin: (request) => invoke(IPC_CHANNELS.accountLoginResize, request),
    cancelLogin: (request) => invoke(IPC_CHANNELS.accountLoginCancel, request),
    listAliases: (request = {}) => invoke(IPC_CHANNELS.accountAliasList, request),
    bindAlias: (request) => invoke(IPC_CHANNELS.accountAliasBind, request),
    unbindAlias: (request) => invoke(IPC_CHANNELS.accountAliasUnbind, request),
  },
  executionProfile: {
    list: (request = {}) => invoke(IPC_CHANNELS.executionProfileList, request),
    get: (request) => invoke(IPC_CHANNELS.executionProfileGet, request),
    create: (request) => invoke(IPC_CHANNELS.executionProfileCreate, request),
    update: (request) => invoke(IPC_CHANNELS.executionProfileUpdate, request),
    remove: (request) => invoke(IPC_CHANNELS.executionProfileRemove, request),
    setDefault: (request) => invoke(IPC_CHANNELS.executionProfileSetDefault, request),
  },
  permission: {
    listRules: (request = {}) => invoke(IPC_CHANNELS.permissionListRules, request),
    createRule: (request) => invoke(IPC_CHANNELS.permissionCreateRule, request),
    updateRule: (request) => invoke(IPC_CHANNELS.permissionUpdateRule, request),
    deleteRule: (request) => invoke(IPC_CHANNELS.permissionDeleteRule, request),
    listAudit: (request = {}) => invoke(IPC_CHANNELS.permissionListAudit, request),
    resolveProfile: (request) => invoke(IPC_CHANNELS.permissionResolveProfile, request),
    resolveDecision: (request) => invoke(IPC_CHANNELS.permissionResolveDecision, request),
  },
  git: {
    status: (request) => invoke(IPC_CHANNELS.gitStatus, request),
    branch: (request) => invoke(IPC_CHANNELS.gitBranch, request),
    init: (request) => invoke(IPC_CHANNELS.gitInit, request),
    diff: (request) => invoke(IPC_CHANNELS.gitDiff, request),
    log: (request) => invoke(IPC_CHANNELS.gitLog, request),
    commit: (request) => invoke(IPC_CHANNELS.gitCommit, request),
    changes: (request) => invoke(IPC_CHANNELS.gitChanges, request),
    filePatch: (request) => invoke(IPC_CHANNELS.gitFilePatch, request),
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
  maintenance: {
    planRetention: (request = {}) => invoke(IPC_CHANNELS.maintenanceRetentionPlan, request),
    runRetention: (request = {}) => invoke(IPC_CHANNELS.maintenanceRetentionRun, request),
    cancelRetention: () => invoke(IPC_CHANNELS.maintenanceRetentionCancel),
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
  recovery: {
    list: (request = {}) => invoke(IPC_CHANNELS.recoveryList, request),
  },
  settings: {
    resolveConfig: (request = {}) => invoke(IPC_CHANNELS.settingsResolveConfig, request),
    updateConfig: (request) => invoke(IPC_CHANNELS.settingsUpdateConfig, request),
    openDirectory: (request) => invoke(IPC_CHANNELS.systemOpenDirectory, request),
  },
  credential: {
    status: () => invoke(IPC_CHANNELS.credentialStatus),
    set: (request) => invoke(IPC_CHANNELS.credentialSet, request),
    delete: (request) => invoke(IPC_CHANNELS.credentialDelete, request),
    list: () => invoke(IPC_CHANNELS.credentialList),
  },
  prompts: {
    list: (request = {}) => invoke(IPC_CHANNELS.promptListTemplates, request),
    render: (request) => invoke(IPC_CHANNELS.promptRender, request),
  },
  workflow: {
    listDefinitions: (request) => invoke(IPC_CHANNELS.workflowListDefinitions, request),
    loadDefinition: (request) => invoke(IPC_CHANNELS.workflowLoadDefinition, request),
    listRuns: (request = {}) => invoke(IPC_CHANNELS.workflowRunList, request),
    getRun: (request) => invoke(IPC_CHANNELS.workflowRunGet, request),
    startRun: (request) => invoke(IPC_CHANNELS.workflowRunStart, request),
    cancelRun: (request) => invoke(IPC_CHANNELS.workflowRunCancel, request),
    completeRun: (request) => invoke(IPC_CHANNELS.workflowRunComplete, request),
    resolveStep: (request) => invoke(IPC_CHANNELS.workflowStepResolve, request),
    confirmShellStep: (request) => invoke(IPC_CHANNELS.workflowShellConfirmation, request),
    listPendingShellConfirmations: (request = {}) =>
      invoke(IPC_CHANNELS.workflowListPendingShellConfirmations, request),
    dispatch: (request) => invoke(IPC_CHANNELS.workflowDispatch, request),
    iterate: (request) => invoke(IPC_CHANNELS.workflowIterate, request),
    startFullWorkflow: (request) => invoke(IPC_CHANNELS.workflowStartFull, request),
    runSummary: (request) => invoke(IPC_CHANNELS.workflowRunSummary, request),
  },
  decision: {
    list: (request = {}) => invoke(IPC_CHANNELS.decisionList, request),
    resolve: (request) => invoke(IPC_CHANNELS.decisionResolve, request),
  },
  events: eventSubscriptions,
}

contextBridge.exposeInMainWorld('teskra', bridge)
