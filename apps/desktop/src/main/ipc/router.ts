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
    ipcChannelDefinitions.workspaceUpdateTrust,
    withRuntime((runtime, request) => runtime.workspace.updateTrust(request)),
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
    ipcChannelDefinitions.criteriaListSets,
    withRuntime((runtime, request) => runtime.criteria.listSets(request)),
  )
  register(
    ipcChannelDefinitions.criteriaGetSet,
    withRuntime((runtime, request) => runtime.criteria.getSet(request)),
  )
  register(
    ipcChannelDefinitions.criteriaCreateSet,
    withRuntime((runtime, request) => runtime.criteria.createSet(request)),
  )
  register(
    ipcChannelDefinitions.criteriaAddCriterion,
    withRuntime((runtime, request) => runtime.criteria.addCriterion(request)),
  )
  register(
    ipcChannelDefinitions.criteriaUpdateCriterion,
    withRuntime((runtime, request) => runtime.criteria.updateCriterion(request)),
  )
  register(
    ipcChannelDefinitions.criteriaRemoveCriterion,
    withRuntime((runtime, request) => runtime.criteria.removeCriterion(request)),
  )
  register(
    ipcChannelDefinitions.criteriaConfirmSet,
    withRuntime((runtime, request) => runtime.criteria.confirmSet(request)),
  )
  register(
    ipcChannelDefinitions.criteriaSupersedeSet,
    withRuntime((runtime, request) => runtime.criteria.supersedeSet(request)),
  )
  register(
    ipcChannelDefinitions.criteriaBindRun,
    withRuntime((runtime, request) => runtime.criteria.bindRun(request)),
  )
  register(
    ipcChannelDefinitions.artifactRecord,
    withRuntime((runtime, request) => runtime.artifact.record(request)),
  )
  register(
    ipcChannelDefinitions.artifactList,
    withRuntime((runtime, request) => runtime.artifact.list(request)),
  )
  register(
    ipcChannelDefinitions.artifactGet,
    withRuntime((runtime, request) => runtime.artifact.get(request)),
  )
  register(
    ipcChannelDefinitions.artifactScanRun,
    withRuntime((runtime, request) => runtime.artifact.scanRun(request)),
  )
  register(
    ipcChannelDefinitions.handoffGet,
    withRuntime((runtime, request) => runtime.handoff.get(request)),
  )
  register(
    ipcChannelDefinitions.memoryList,
    withRuntime((runtime, request) => runtime.memory.list(request)),
  )
  register(
    ipcChannelDefinitions.memoryGet,
    withRuntime((runtime, request) => runtime.memory.get(request)),
  )
  register(
    ipcChannelDefinitions.memoryCreate,
    withRuntime((runtime, request) => runtime.memory.create(request)),
  )
  register(
    ipcChannelDefinitions.memoryUpdate,
    withRuntime((runtime, request) => runtime.memory.update(request)),
  )
  register(
    ipcChannelDefinitions.memoryDelete,
    withRuntime((runtime, request) => runtime.memory.delete(request)),
  )
  register(
    ipcChannelDefinitions.contextPreview,
    withRuntime((runtime, request) => runtime.context.preview(request)),
  )
  register(
    ipcChannelDefinitions.reviewListFindings,
    withRuntime((runtime, request) => runtime.review.listFindings(request)),
  )
  register(
    ipcChannelDefinitions.reviewListCriterionScores,
    withRuntime((runtime, request) => runtime.review.listCriterionScores(request)),
  )
  register(
    ipcChannelDefinitions.reviewPanelStart,
    withRuntime((runtime, request) => runtime.review.startPanel(request)),
  )
  register(
    ipcChannelDefinitions.reviewPanelGet,
    withRuntime((runtime, request) => runtime.review.getPanel(request)),
  )
  register(
    ipcChannelDefinitions.reviewPanelList,
    withRuntime((runtime, request) => runtime.review.listPanels(request)),
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
    ipcChannelDefinitions.agentRunReviewStart,
    withRuntime((runtime, request) => runtime.agent.startReview(request)),
  )
  register(
    ipcChannelDefinitions.agentRunResume,
    withRuntime((runtime, request) => runtime.agent.resume(request)),
  )
  register(
    ipcChannelDefinitions.agentRunContinueWithProfile,
    withRuntime((runtime, request) => runtime.agent.continueWithProfile(request)),
  )
  register(
    ipcChannelDefinitions.accountList,
    withRuntime((runtime, request) => runtime.account.list(request)),
  )
  register(
    ipcChannelDefinitions.accountGet,
    withRuntime((runtime, request) => runtime.account.get(request)),
  )
  register(
    ipcChannelDefinitions.accountCreate,
    withRuntime((runtime, request) => runtime.account.create(request)),
  )
  register(
    ipcChannelDefinitions.accountUpdate,
    withRuntime((runtime, request) => runtime.account.update(request)),
  )
  register(
    ipcChannelDefinitions.accountRemove,
    withRuntime((runtime, request) => runtime.account.remove(request)),
  )
  register(
    ipcChannelDefinitions.accountDetect,
    withRuntime((runtime, request) => runtime.account.detect(request)),
  )
  register(
    ipcChannelDefinitions.accountDisable,
    withRuntime((runtime, request) => runtime.account.disable(request)),
  )
  register(
    ipcChannelDefinitions.accountEnable,
    withRuntime((runtime, request) => runtime.account.enable(request)),
  )
  register(
    ipcChannelDefinitions.accountSetDefault,
    withRuntime((runtime, request) => runtime.account.setDefault(request)),
  )
  register(
    ipcChannelDefinitions.accountLoginStart,
    withRuntime((runtime, request) => runtime.account.startLogin(request)),
  )
  register(
    ipcChannelDefinitions.accountLoginWrite,
    withRuntime((runtime, request) => runtime.account.writeLogin(request)),
  )
  register(
    ipcChannelDefinitions.accountLoginResize,
    withRuntime((runtime, request) => runtime.account.resizeLogin(request)),
  )
  register(
    ipcChannelDefinitions.accountLoginCancel,
    withRuntime((runtime, request) => runtime.account.cancelLogin(request)),
  )
  register(
    ipcChannelDefinitions.accountAliasList,
    withRuntime((runtime, request) => runtime.account.listAliases(request)),
  )
  register(
    ipcChannelDefinitions.accountAliasBind,
    withRuntime((runtime, request) => runtime.account.bindAlias(request)),
  )
  register(
    ipcChannelDefinitions.accountAliasUnbind,
    withRuntime((runtime, request) => runtime.account.unbindAlias(request)),
  )
  register(
    ipcChannelDefinitions.executionProfileList,
    withRuntime((runtime, request) => runtime.executionProfile.list(request)),
  )
  register(
    ipcChannelDefinitions.executionProfileGet,
    withRuntime((runtime, request) => runtime.executionProfile.get(request)),
  )
  register(
    ipcChannelDefinitions.executionProfileCreate,
    withRuntime((runtime, request) => runtime.executionProfile.create(request)),
  )
  register(
    ipcChannelDefinitions.executionProfileUpdate,
    withRuntime((runtime, request) => runtime.executionProfile.update(request)),
  )
  register(
    ipcChannelDefinitions.executionProfileRemove,
    withRuntime((runtime, request) => runtime.executionProfile.remove(request)),
  )
  register(
    ipcChannelDefinitions.executionProfileSetDefault,
    withRuntime((runtime, request) => runtime.executionProfile.setDefault(request)),
  )
  register(
    ipcChannelDefinitions.permissionListRules,
    withRuntime((runtime, request) => runtime.permission.listRules(request)),
  )
  register(
    ipcChannelDefinitions.permissionCreateRule,
    withRuntime((runtime, request) => runtime.permission.createRule(request)),
  )
  register(
    ipcChannelDefinitions.permissionUpdateRule,
    withRuntime((runtime, request) => runtime.permission.updateRule(request)),
  )
  register(
    ipcChannelDefinitions.permissionDeleteRule,
    withRuntime((runtime, request) => runtime.permission.deleteRule(request)),
  )
  register(
    ipcChannelDefinitions.permissionListAudit,
    withRuntime((runtime, request) => runtime.permission.listAudit(request)),
  )
  register(
    ipcChannelDefinitions.permissionResolveProfile,
    withRuntime((runtime, request) => runtime.permission.resolveProfile(request)),
  )
  register(
    ipcChannelDefinitions.permissionResolveDecision,
    withRuntime((runtime, request) => runtime.permission.resolveDecision(request)),
  )
  register(
    ipcChannelDefinitions.agentRunSend,
    withRuntime((runtime, request) => runtime.agent.send(request)),
  )
  register(
    ipcChannelDefinitions.agentRunResize,
    withRuntime((runtime, request) => runtime.agent.resize(request)),
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
    ipcChannelDefinitions.gitFilePatch,
    withRuntime((runtime, request) => runtime.git.filePatch(request)),
  )
  register(
    ipcChannelDefinitions.gitOpenFile,
    withRuntime((runtime, request) => runtime.git.openFile(request)),
  )
  register(
    ipcChannelDefinitions.worktreeCreate,
    withRuntime((runtime, request) => runtime.worktree.create(request)),
  )
  register(
    ipcChannelDefinitions.worktreeList,
    withRuntime((runtime, request) => runtime.worktree.list(request)),
  )
  register(
    ipcChannelDefinitions.worktreeValidate,
    withRuntime((runtime, request) => runtime.worktree.validate(request)),
  )
  register(
    ipcChannelDefinitions.worktreeMergePreflight,
    withRuntime((runtime, request) => runtime.worktree.preflight(request)),
  )
  register(
    ipcChannelDefinitions.worktreeMerge,
    withRuntime((runtime, request) => runtime.worktree.merge(request)),
  )
  register(
    ipcChannelDefinitions.worktreeDiscard,
    withRuntime((runtime, request) => runtime.worktree.discard(request)),
  )
  register(
    ipcChannelDefinitions.worktreeArchive,
    withRuntime((runtime, request) => runtime.worktree.archive(request)),
  )
  register(
    ipcChannelDefinitions.worktreeCleanup,
    withRuntime((runtime, request) => runtime.worktree.cleanup(request)),
  )
  register(
    ipcChannelDefinitions.maintenanceRetentionPlan,
    withRuntime((runtime, request) => runtime.maintenance.planRetention(request)),
  )
  register(
    ipcChannelDefinitions.maintenanceRetentionRun,
    withRuntime((runtime, request) => runtime.maintenance.runRetention(request)),
  )
  register(
    ipcChannelDefinitions.maintenanceRetentionCancel,
    withRuntime((runtime) => runtime.maintenance.cancelRetention()),
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
    withRuntime((runtime, request) => {
      const result = requireRuntimePort(runtime, request.name)
      // A runtime port is a live Main-process object with methods; it cannot
      // survive Electron structured clone. The channel is a capability probe,
      // so only the availability signal crosses IPC.
      return result.ok ? { ok: true, data: null } : result
    }),
  )
  register(
    ipcChannelDefinitions.doctorRun,
    withRuntime((runtime, request) => runtime.system.doctor(request)),
  )
  register(
    ipcChannelDefinitions.recoveryList,
    withRuntime((runtime, request) => runtime.recovery.list(request)),
  )
  register(
    ipcChannelDefinitions.promptListTemplates,
    withRuntime((runtime, request) => runtime.prompts.list(request)),
  )
  register(
    ipcChannelDefinitions.promptRender,
    withRuntime((runtime, request) => runtime.prompts.render(request)),
  )
  register(
    ipcChannelDefinitions.workflowListDefinitions,
    withRuntime((runtime, request) => runtime.workflow.listDefinitions(request)),
  )
  register(
    ipcChannelDefinitions.workflowLoadDefinition,
    withRuntime((runtime, request) => runtime.workflow.loadDefinition(request)),
  )
  register(
    ipcChannelDefinitions.workflowRunList,
    withRuntime((runtime, request) => runtime.workflow.listRuns(request)),
  )
  register(
    ipcChannelDefinitions.workflowRunGet,
    withRuntime((runtime, request) => runtime.workflow.getRun(request)),
  )
  register(
    ipcChannelDefinitions.workflowRunStart,
    withRuntime((runtime, request) => runtime.workflow.startRun(request)),
  )
  register(
    ipcChannelDefinitions.workflowRunCancel,
    withRuntime((runtime, request) => runtime.workflow.cancelRun(request)),
  )
  register(
    ipcChannelDefinitions.workflowRunComplete,
    withRuntime((runtime, request) => runtime.workflow.completeRun(request)),
  )
  register(
    ipcChannelDefinitions.workflowStepResolve,
    withRuntime((runtime, request) => runtime.workflow.resolveStep(request)),
  )
  register(
    ipcChannelDefinitions.workflowShellConfirmation,
    withRuntime((runtime, request) => runtime.workflow.confirmShellStep(request)),
  )
  register(
    ipcChannelDefinitions.workflowListPendingShellConfirmations,
    withRuntime((runtime, request) => runtime.workflow.listPendingShellConfirmations(request)),
  )
  register(
    ipcChannelDefinitions.workflowDispatch,
    withRuntime((runtime, request) => runtime.workflow.dispatch(request)),
  )
  register(
    ipcChannelDefinitions.workflowIterate,
    withRuntime((runtime, request) => runtime.workflow.iterate(request)),
  )
  register(
    ipcChannelDefinitions.workflowStartFull,
    withRuntime((runtime, request) => runtime.workflow.startFullWorkflow(request)),
  )
  register(
    ipcChannelDefinitions.workflowRunSummary,
    withRuntime((runtime, request) => runtime.workflow.runSummary(request)),
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
    ipcChannelDefinitions.credentialStatus,
    withRuntime((runtime) => runtime.credential.status()),
  )
  register(
    ipcChannelDefinitions.credentialSet,
    withRuntime((runtime, request) => runtime.credential.set(request)),
  )
  register(
    ipcChannelDefinitions.credentialDelete,
    withRuntime((runtime, request) => runtime.credential.delete(request)),
  )
  register(
    ipcChannelDefinitions.credentialList,
    withRuntime((runtime) => runtime.credential.list()),
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
