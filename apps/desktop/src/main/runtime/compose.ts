import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type {
  IpcResult,
  PublicAppError,
  SystemHealth,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'

import { createConfigService } from '../config/config-service'
import { APP_VERSION } from '../build-info'
import { createArtifactStore } from '../artifacts/artifact-store'
import { createAgentDetector } from '../agents/agent-detector'
import { createAgentHealthManager } from '../agents/agent-health-manager'
import { createAgentManager } from '../agents/agent-manager'
import { createDefaultAgentRegistry } from '../agents/agent-registry'
import { createAccountProfileAdapterRegistry } from '../agents/accounts/account-profile-adapter'
import { createAccountProfileManager } from '../agents/accounts/account-profile-manager'
import { createClaudeAccountProfileAdapter } from '../agents/accounts/adapters/claude-account-profile-adapter'
import { registerCodexAccountProfileAdapter } from '../agents/accounts/adapters/codex-account-profile-adapter'
import { createClaudeAdapter } from '../agents/adapters/claude-adapter'
import { createCodexAdapter } from '../agents/adapters/codex-adapter'
import { createFakeAgentAdapter } from '../agents/adapters/fake-agent-adapter'
import { createKimiAdapter } from '../agents/adapters/kimi-adapter'
import { createRunLogStore } from '../agents/run-log-store'
import { openDatabase, type TeskraDatabase } from '../db'
import { migrateDatabase } from '../db/migrations'
import {
  createAgentEventRepository,
  createAgentRunRepository,
  createAccountProfileRepository,
  createArtifactRepository,
  createCriteriaRepository,
  createHandoffRepository,
  createMemoryRepository,
  createPermissionRepository,
  createReviewRepository,
  createTaskRepository,
  createWorkflowRunRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
} from '../db/repositories'
import { createEventBus } from '../events/event-bus'
import { createAutoCommitService } from '../git/auto-commit-service'
import { createDiffService } from '../git/diff-service'
import { createGitManager } from '../git/git-manager'
import { createMergePreflightService } from '../git/merge-preflight-service'
import { createMergeService } from '../git/merge-service'
import { createWorktreeManager } from '../git/worktree-manager'
import { createDoctorService } from '../doctor/doctor-service'
import { getLogger, initializeLogging } from '../logger'
import { createRetentionService } from '../maintenance/retention-service'
import { createTeskraPaths, type TeskraPaths } from '../paths'
import { createCommandRunner, type CommandRunner } from '../process/command-runner'
import { createHostProcessControl } from '../process/host-processes'
import { createProcessManager } from '../process/process-manager'
import { createPermissionManager } from '../permissions/permission-manager'
import { createPromptTemplateService } from '../prompts/prompt-template-service'
import { createReconciliationService } from '../recovery/reconciliation-service'
import { createRecoveryCenterService } from '../recovery/recovery-center-service'
import { createResumeService } from '../recovery/resume-service'
import { createReviewCollector } from '../agents/review-collector'
import { createReviewPanelService } from '../agents/review-panel-service'
import { createReviewerService } from '../agents/reviewer-service'
import {
  createCredentialStore,
  createUnavailableCipher,
  type CredentialCipher,
} from '../security/credential-store'
import { createTerminalManager } from '../terminal/terminal-manager'
import { createCriteriaManager } from '../tasks/criteria-manager'
import { createMemoryManager } from '../memory/memory-manager'
import { createContextBuilder } from '../memory/context-builder'
import { createTaskManager } from '../tasks/task-manager'
import { createWorkflowDefinitionLoader } from '../workflows/definition-loader'
import { createCriteriaGateStepExecutor } from '../workflows/criteria-gate-step-executor'
import { createDispatchService } from '../workflows/dispatch-service'
import { createFullWorkflowService } from '../workflows/full-workflow-service'
import { createIterationController } from '../workflows/iteration-controller'
import { createReviewPanelStepExecutor } from '../workflows/review-panel-step-executor'
import { createShellStepExecutor } from '../workflows/shell-step-executor'
import { createWorkflowEngine } from '../workflows/workflow-engine'
import { createWorkflowRunStore } from '../workflows/workflow-run-store'
import {
  createWorkspaceRuntime,
  type WorkspaceRuntime,
  type WslEnvironmentInfo,
} from '../workspace/runtime'
import { createWorkspaceManager } from '../workspace/workspace-manager'
import { createWslManager } from '../workspace/wsl-manager'
import type { TeskraRuntime } from './facade'

export interface ComposeRuntimeOptions {
  readonly paths?: TeskraPaths
  readonly database?: TeskraDatabase
  readonly commands?: CommandRunner
  readonly appVersion?: string
  readonly runtimeVersion?: string
  readonly hostPlatform?: NodeJS.Platform
  /** Test/startup override; otherwise WslManager probes without blocking availability. */
  readonly wslInfo?: WslEnvironmentInfo
  /** Defaults true. Tests may disable filesystem logging. */
  readonly initializeLogs?: boolean
  /** Electron shell adapter, injected by main/index.ts to keep Runtime Electron-free. */
  readonly openPath?: (path: string) => Promise<string>
  /** Electron directory dialog adapter, injected by main/index.ts. */
  readonly selectDirectory?: () => Promise<string | null>
  /** Explicit packaging boundary: Fake Agent is available only in development/tests. */
  readonly includeDevelopmentAgents?: boolean
  /** Test/dev override for the repository-distributed Fake Agent script. */
  readonly fakeAgentScriptPath?: string
  /**
   * TASK-088: OS-backed encryption provider (Electron safeStorage), injected
   * by main/index.ts to keep the Runtime Electron-free. Without it the
   * Credential Store degrades explicitly to "unavailable".
   */
  readonly credentialCipher?: CredentialCipher
}

function createRepositories(connection: TeskraDatabase['connection']) {
  return {
    workspaces: createWorkspaceRepository(connection),
    tasks: createTaskRepository(connection),
    agentRuns: createAgentRunRepository(connection),
    agentEvents: createAgentEventRepository(connection),
    accountProfiles: createAccountProfileRepository(connection),
    artifacts: createArtifactRepository(connection),
    worktrees: createWorktreeRepository(connection),
    workflowRuns: createWorkflowRunRepository(connection),
    criteria: createCriteriaRepository(connection),
    reviews: createReviewRepository(connection),
    handoffs: createHandoffRepository(connection),
    memory: createMemoryRepository(connection),
    permissions: createPermissionRepository(connection),
  }
}

/**
 * The only application composition root (TASK-081). It is Electron-free and
 * can be instantiated under plain Node; main/index.ts owns only Electron
 * lifecycle/window concerns and supplies the app version.
 */
export async function composeTeskraRuntime(
  options: ComposeRuntimeOptions = {},
): Promise<IpcResult<TeskraRuntime>> {
  const paths = options.paths ?? createTeskraPaths()
  if (options.initializeLogs !== false) {
    const logging = initializeLogging(paths)
    if (!logging.ok) {
      getLogger('app').error(
        { err: logging.error },
        'File logging unavailable; falling back to stdout.',
      )
    }
  }

  const opened =
    options.database === undefined
      ? openDatabase(paths)
      : { ok: true as const, data: options.database }
  if (!opened.ok) {
    return opened
  }
  const database = opened.data
  const migrated = migrateDatabase(database.connection)
  if (!migrated.ok) {
    database.close()
    return migrated
  }

  const repositories = createRepositories(database.connection)
  const config = createConfigService({ paths, workspaces: repositories.workspaces })
  const resolvedConfig = config.resolve()
  if (!resolvedConfig.ok) {
    database.close()
    return resolvedConfig
  }

  const registeredAgents = createDefaultAgentRegistry(options.includeDevelopmentAgents === true)
  if (!registeredAgents.ok) {
    database.close()
    return registeredAgents
  }

  const events = createEventBus()
  const commands = options.commands ?? createCommandRunner({ hostPlatform: options.hostPlatform })
  const wsl = createWslManager({ commands, config })
  let wslInfo = options.wslInfo
  if (wslInfo === undefined) {
    const detected = await wsl.getRuntimeInfo()
    if (detected.ok) {
      wslInfo = detected.data
    } else {
      wslInfo = { available: false }
      getLogger('runtime').info(
        { err: detected.error },
        'WSL unavailable; WSL workspaces disabled.',
      )
    }
  }

  const runtimeFor = (ref: WorkspaceRuntimeRef) =>
    createWorkspaceRuntime(ref, { paths, hostPlatform: options.hostPlatform, wsl: wslInfo })
  const credentials = createCredentialStore({
    paths,
    cipher: options.credentialCipher ?? createUnavailableCipher(),
  })
  if (!credentials.isAvailable()) {
    getLogger('security').warn(
      'Credential encryption is unavailable; sensitive values will not be persisted.',
    )
  }
  const workspaceManager = createWorkspaceManager(repositories.workspaces, {
    createRuntime: runtimeFor,
    credentials,
  })
  const processManager = createProcessManager({
    events,
    hostPlatform: options.hostPlatform,
  })
  const terminalManager = createTerminalManager({
    processes: processManager,
    events,
    workspaces: repositories.workspaces,
    resolveRuntime: (workspace) => runtimeFor(workspace.runtime),
    credentials,
  })
  const taskManager = createTaskManager({
    tasks: repositories.tasks,
    workspaces: repositories.workspaces,
    events,
  })
  const promptTemplates = createPromptTemplateService({ paths })
  const workflowDefinitions = createWorkflowDefinitionLoader({ paths })
  const workflowRunStore = createWorkflowRunStore({
    workflowRuns: repositories.workflowRuns,
    tasks: repositories.tasks,
  })
  /** Maps a Facade workspaceId to its repo path for repo-local overrides. */
  const repoRootFor = (workspaceId?: string): IpcResult<string | undefined> => {
    if (workspaceId === undefined) {
      return { ok: true, data: undefined }
    }
    const workspace = repositories.workspaces.getById(workspaceId)
    if (!workspace.ok) {
      return workspace
    }
    if (workspace.data === null) {
      return {
        ok: false,
        error: {
          code: 'WORKSPACE_NOT_FOUND',
          message: 'The selected workspace no longer exists.',
          retryable: false,
        },
      }
    }
    return { ok: true, data: workspace.data.path }
  }
  const criteriaManager = createCriteriaManager({
    criteria: repositories.criteria,
    tasks: repositories.tasks,
    runs: repositories.agentRuns,
    events,
  })
  const memoryManager = createMemoryManager({
    memory: repositories.memory,
    workspaces: repositories.workspaces,
    paths,
  })
  const contextBuilder = createContextBuilder({
    tasks: repositories.tasks,
    criteria: repositories.criteria,
    runs: repositories.agentRuns,
    handoffs: repositories.handoffs,
    memory: memoryManager,
  })
  const artifactStore = createArtifactStore({
    artifacts: repositories.artifacts,
    tasks: repositories.tasks,
    runs: repositories.agentRuns,
    events,
    paths,
  })
  const gitManager = createGitManager({
    commands,
    workspaces: repositories.workspaces,
    events,
    resolveRuntime: (workspace) => runtimeFor(workspace.runtime),
    openPath: options.openPath,
  })
  const diffService = createDiffService({ git: gitManager })
  const worktreeManager = createWorktreeManager({
    commands,
    workspaces: repositories.workspaces,
    worktrees: repositories.worktrees,
    events,
    resolveRuntime: (workspace) => runtimeFor(workspace.runtime),
  })
  const mergePreflight = createMergePreflightService({
    commands,
    workspaces: repositories.workspaces,
    worktrees: repositories.worktrees,
    runs: repositories.agentRuns,
    criteria: repositories.criteria,
    reviews: repositories.reviews,
    resolveRuntime: (workspace) => runtimeFor(workspace.runtime),
  })
  const mergeService = createMergeService({
    commands,
    workspaces: repositories.workspaces,
    worktrees: repositories.worktrees,
    runs: repositories.agentRuns,
    tasks: repositories.tasks,
    events,
    preflight: mergePreflight,
    resolveRuntime: (workspace) => runtimeFor(workspace.runtime),
  })
  // TASK-069: the RetentionService GC reads the `retention` config group per
  // workspace through the Config Layers (TASK-080).
  const retentionService = createRetentionService({
    commands,
    workspaces: repositories.workspaces,
    worktrees: repositories.worktrees,
    runs: repositories.agentRuns,
    handoffs: repositories.handoffs,
    events,
    paths,
    resolveRuntime: (workspace) => runtimeFor(workspace.runtime),
    resolvePolicy: (workspaceId) => {
      const resolved = config.resolve(workspaceId === undefined ? undefined : { workspaceId })
      return resolved.ok ? { ok: true, data: resolved.data.config.retention } : resolved
    },
  })
  const agentDetector = createAgentDetector({
    registry: registeredAgents.data,
    commands,
    config,
    resolveRuntime: runtimeFor,
  })
  const agentHealth = createAgentHealthManager({
    registry: registeredAgents.data,
    detector: agentDetector,
  })
  // Milestone 24 (TASK-100): the account-profile adapter registry (Codex /
  // Claude) and the AccountProfileManager. resolveExecutable surfaces the
  // detector's per-runtime executable override for login commands; detection
  // itself is async and stays with the Login Terminal (TASK-102/104).
  const accountProfileAdapters = createAccountProfileAdapterRegistry()
  if (!accountProfileAdapters.ok) {
    database.close()
    return accountProfileAdapters
  }
  const codexAccountAdapter = registerCodexAccountProfileAdapter(accountProfileAdapters.data, {
    commands,
    createRuntime: runtimeFor,
    resolveExecutable: (profile) => {
      const override = agentDetector.getExecutableOverride({
        agentId: profile.agentId,
        runtime: profile.runtime,
      })
      return override.ok ? (override.data ?? undefined) : undefined
    },
  })
  if (!codexAccountAdapter.ok) {
    database.close()
    return codexAccountAdapter
  }
  const claudeAccountAdapter = accountProfileAdapters.data.register(
    createClaudeAccountProfileAdapter({ commands, createRuntime: runtimeFor }),
  )
  if (!claudeAccountAdapter.ok) {
    database.close()
    return claudeAccountAdapter
  }
  const accountProfileManager = createAccountProfileManager({
    profiles: repositories.accountProfiles,
    runs: repositories.agentRuns,
    registry: registeredAgents.data,
    paths,
    config,
    events,
    adapters: accountProfileAdapters.data,
    createRuntime: runtimeFor,
    commands,
  })
  const doctor = createDoctorService({
    paths,
    database,
    commands,
    wsl,
    registry: registeredAgents.data,
    detector: agentDetector,
    workspaces: repositories.workspaces,
    worktrees: repositories.worktrees,
    runs: repositories.agentRuns,
    processes: processManager,
    git: gitManager,
    resolveRuntime: (workspace) => runtimeFor(workspace.runtime),
  })
  const adapterOptions = {
    processes: processManager,
    detector: agentDetector,
    resolveRuntime: runtimeFor,
  }
  const runLogs = createRunLogStore({ paths })
  const permissionManager = createPermissionManager({
    permissions: repositories.permissions,
    runs: repositories.agentRuns,
    registry: registeredAgents.data,
    events,
  })
  const reviewCollector = createReviewCollector({
    reviews: repositories.reviews,
    runs: repositories.agentRuns,
    criteria: repositories.criteria,
  })
  // P0-2: host-side pid probe/identity/terminate, shared by AgentManager
  // (identity capture at launch) and Reconciliation (survivor verification).
  const hostProcesses = createHostProcessControl({
    commands,
    hostPlatform: options.hostPlatform,
  })
  const agentManager = createAgentManager({
    registry: registeredAgents.data,
    adapters: [
      createCodexAdapter(adapterOptions),
      createClaudeAdapter(adapterOptions),
      createKimiAdapter(adapterOptions),
      ...(options.includeDevelopmentAgents === true
        ? [
            createFakeAgentAdapter({
              ...adapterOptions,
              scriptPath:
                options.fakeAgentScriptPath ?? resolve(process.cwd(), 'tools/fake-agent.js'),
            }),
          ]
        : []),
    ],
    runs: repositories.agentRuns,
    agentEvents: repositories.agentEvents,
    handoffs: repositories.handoffs,
    reviewCollector,
    workspaces: repositories.workspaces,
    tasks: repositories.tasks,
    worktrees: repositories.worktrees,
    events,
    paths,
    runLogs,
    permissions: permissionManager,
    hostProcesses,
    credentials,
    accountProfiles: accountProfileManager,
    resolveRuntime: runtimeFor,
    resolveConcurrency: (workspaceId) => {
      const resolved = config.resolve({ workspaceId })
      return resolved.ok ? { ok: true, data: resolved.data.config.concurrency } : resolved
    },
  })
  const autoCommit = createAutoCommitService({
    commands,
    runs: repositories.agentRuns,
    workspaces: repositories.workspaces,
    worktrees: repositories.worktrees,
    handoffs: repositories.handoffs,
    events,
    resolveRuntime: (workspace) => runtimeFor(workspace.runtime),
  })
  const resumeService = createResumeService({
    runs: repositories.agentRuns,
    workspaces: repositories.workspaces,
    worktrees: repositories.worktrees,
    processes: processManager,
    git: gitManager,
    agentManager,
    resolveRuntime: (workspace) => runtimeFor(workspace.runtime),
  })
  const recoveryCenter = createRecoveryCenterService({
    workspaces: repositories.workspaces,
    worktrees: repositories.worktrees,
    runs: repositories.agentRuns,
    processes: processManager,
    git: gitManager,
    resolveRuntime: (workspace) => runtimeFor(workspace.runtime),
    resolveStalledThresholdMs: (workspaceId) => {
      const resolved = config.resolve({ workspaceId })
      return resolved.ok
        ? { ok: true, data: resolved.data.config.watchdog.stalledThresholdMs }
        : resolved
    },
  })
  const reviewerService = createReviewerService({
    registry: registeredAgents.data,
    agents: agentManager,
    worktreeManager,
    runs: repositories.agentRuns,
    worktrees: repositories.worktrees,
    events,
  })
  // TASK-060: the Review Panel composes ReviewerService (one independent
  // reviewer Run per panel member) + the review persistence; the engine's
  // review-panel nodes execute through it instead of suspending.
  const reviewPanelService = createReviewPanelService({
    registry: registeredAgents.data,
    reviewer: reviewerService,
    agents: agentManager,
    runs: repositories.agentRuns,
    worktrees: repositories.worktrees,
    reviews: repositories.reviews,
    tasks: repositories.tasks,
    workspaces: repositories.workspaces,
    criteria: repositories.criteria,
    handoffs: repositories.handoffs,
    promptTemplates,
    paths,
    events,
    // TASK-061: the Review Aggregator's severity policy comes from the
    // resolved config layers (TASK-080).
    resolvePolicy: (workspaceId) => {
      const resolved = config.resolve({ workspaceId })
      return resolved.ok
        ? {
            ok: true,
            data: { mediumBlockThreshold: resolved.data.config.review.mediumBlockThreshold },
          }
        : resolved
    },
  })
  // TASK-057/059: the engine drives WorkflowRun passes; Dispatch composes
  // WorktreeManager + PromptTemplateService + the engine for Task → One Agent
  // → Handoff.
  const workflowEngine = createWorkflowEngine({
    runs: workflowRunStore,
    events,
    agentManager,
    executors: {
      'review-panel': createReviewPanelStepExecutor({ panel: reviewPanelService, events }),
    },
  })
  const dispatchService = createDispatchService({
    runs: workflowRunStore,
    engine: workflowEngine,
    registry: registeredAgents.data,
    tasks: repositories.tasks,
    criteria: repositories.criteria,
    workspaces: repositories.workspaces,
    worktreeManager,
    agents: agentManager,
    handoffs: repositories.handoffs,
    promptTemplates,
    contextBuilder,
    paths,
    events,
  })
  // TASK-062: the Iterate Primitive drives the loop the engine deliberately
  // does not have — one DAG pass per round, safety caps per plan §124.
  const iterationController = createIterationController({
    runs: workflowRunStore,
    engine: workflowEngine,
    registry: registeredAgents.data,
    tasks: repositories.tasks,
    taskManager,
    criteria: repositories.criteria,
    workspaces: repositories.workspaces,
    events,
    promptTemplates,
    handoffs: repositories.handoffs,
    paths,
  })
  // TASK-063: the default full workflow runs on a DEDICATED engine — the
  // generic engine keeps criteria-gate nodes suspended for external
  // resolveStep, while the full workflow needs them auto-evaluated, plus the
  // TASK-058 shell executor for its Build/Test steps.
  const fullWorkflowEngine = createWorkflowEngine({
    runs: workflowRunStore,
    events,
    agentManager,
    executors: {
      shell: createShellStepExecutor({ commands, artifacts: artifactStore }),
      'review-panel': createReviewPanelStepExecutor({ panel: reviewPanelService, events }),
      'criteria-gate': createCriteriaGateStepExecutor({
        reviews: repositories.reviews,
        criteria: repositories.criteria,
      }),
    },
  })
  /** Shell steps execute in the run's worktree under the workspace runtime. */
  const resolveWorkflowStepContext = (input: {
    workspaceId: string
    worktreeId?: string
  }): IpcResult<{ runtime: WorkspaceRuntime; cwd: string } | undefined> => {
    if (input.worktreeId === undefined) return { ok: true, data: undefined }
    const workspace = repositories.workspaces.getById(input.workspaceId)
    if (!workspace.ok) return workspace
    if (workspace.data === null) {
      return {
        ok: false,
        error: {
          code: 'WORKSPACE_NOT_FOUND',
          message: 'The selected workspace no longer exists.',
          retryable: false,
        },
      }
    }
    const runtime = runtimeFor(workspace.data.runtime)
    if (!runtime.ok) return runtime
    const validated = runtime.data.validate()
    if (!validated.ok) return validated
    const worktree = repositories.worktrees.getById(input.worktreeId)
    if (!worktree.ok) return worktree
    if (worktree.data === null) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The workflow worktree no longer exists.',
          retryable: false,
        },
      }
    }
    return {
      ok: true,
      data: { runtime: runtime.data, cwd: runtime.data.resolveCwd(worktree.data.path) },
    }
  }
  const fullWorkflow = createFullWorkflowService({
    runs: workflowRunStore,
    tasks: repositories.tasks,
    workspaces: repositories.workspaces,
    criteria: repositories.criteria,
    reviews: repositories.reviews,
    worktrees: repositories.worktrees,
    registry: registeredAgents.data,
    worktreeManager,
    definitions: workflowDefinitions,
    git: gitManager,
    createController: (firstAgentRunId) => {
      let firstConsumed = false
      return createIterationController({
        runs: workflowRunStore,
        engine: fullWorkflowEngine,
        registry: registeredAgents.data,
        tasks: repositories.tasks,
        taskManager,
        criteria: repositories.criteria,
        workspaces: repositories.workspaces,
        events,
        promptTemplates,
        handoffs: repositories.handoffs,
        paths,
        createAgentRunId: () => {
          if (!firstConsumed) {
            firstConsumed = true
            return firstAgentRunId
          }
          return randomUUID()
        },
        resolveStepContext: resolveWorkflowStepContext,
      })
    },
  })
  const reconciled = await createReconciliationService({
    runs: repositories.agentRuns,
    agentEvents: repositories.agentEvents,
    workspaces: repositories.workspaces,
    worktrees: repositories.worktrees,
    tasks: repositories.tasks,
    processes: processManager,
    commands,
    // P0-2: the in-process registry is empty at startup; the pid probe is the
    // only way to tell a dead run from one whose Agent survived the restart.
    hostProcesses,
    events,
    runLogs,
    resolveRuntime: (workspace) => runtimeFor(workspace.runtime),
  }).reconcile()
  if (!reconciled.ok) {
    getLogger('runtime').error({ error: reconciled.error }, 'Startup reconciliation failed.')
  } else if (
    reconciled.data.missingWorkspaceIds.length > 0 ||
    reconciled.data.brokenWorktrees.length > 0 ||
    reconciled.data.interruptedRunIds.length > 0 ||
    reconciled.data.terminatedSurvivorRunIds.length > 0 ||
    reconciled.data.survivingRunIds.length > 0
  ) {
    getLogger('runtime').warn(reconciled.data, 'Startup reconciliation repaired stale state.')
  }

  let disposed = false
  const runtime: TeskraRuntime = {
    events,
    task: {
      create: (request) => taskManager.create(request),
      update: (request) => taskManager.update(request),
      archive: (request) => taskManager.archive(request),
      delete: ({ id }) => taskManager.delete(id),
      get: ({ id }) => taskManager.get(id),
      list: (request) => taskManager.list(request),
    },
    criteria: {
      listSets: (request) => criteriaManager.listSets(request),
      getSet: (request) => criteriaManager.getSet(request),
      createSet: (request) => criteriaManager.createSet(request),
      addCriterion: (request) => criteriaManager.addCriterion(request),
      updateCriterion: (request) => criteriaManager.updateCriterion(request),
      removeCriterion: (request) => criteriaManager.removeCriterion(request),
      confirmSet: (request) => criteriaManager.confirmSet(request),
      supersedeSet: (request) => criteriaManager.supersedeSet(request),
      bindRun: (request) => criteriaManager.bindRun(request),
    },
    artifact: {
      record: (request) => artifactStore.record(request),
      list: (request) => artifactStore.list(request),
      get: (request) => artifactStore.get(request),
      scanRun: (request) => artifactStore.scanRun(request),
    },
    handoff: {
      get: ({ runId }) => repositories.handoffs.getByRunId(runId),
    },
    memory: {
      list: (request) => memoryManager.list(request),
      get: (request) => memoryManager.get(request),
      create: (request) => memoryManager.create(request),
      update: (request) => memoryManager.update(request),
      delete: (request) => memoryManager.delete(request),
    },
    context: {
      preview: (request) => contextBuilder.buildContext(request),
    },
    permission: {
      listRules: (request) => permissionManager.listRules(request),
      createRule: (request) => permissionManager.createRule(request),
      updateRule: (request) => permissionManager.updateRule(request),
      deleteRule: (request) => permissionManager.deleteRule(request),
      listAudit: (request) => permissionManager.listAudit(request),
      resolveProfile: (request) => permissionManager.resolveProfile(request),
      resolveDecision: (request) => permissionManager.recordDecision(request),
    },
    review: {
      listFindings: (request) => {
        if (request.runId !== undefined) {
          return repositories.reviews.listFindingsByRun(request.runId)
        }
        if (request.taskId !== undefined) {
          return repositories.reviews.listFindingsByTask(request.taskId)
        }
        return {
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Exactly one of runId / taskId is required.',
            retryable: false,
          },
        }
      },
      listCriterionScores: (request) => {
        if (request.runId !== undefined) {
          return repositories.reviews.listScoresByRun(request.runId)
        }
        if (request.taskId !== undefined) {
          return repositories.reviews.listScoresByTask(request.taskId)
        }
        return {
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Exactly one of runId / taskId is required.',
            retryable: false,
          },
        }
      },
      startPanel: (request) => reviewPanelService.startPanel(request),
      getPanel: ({ panelId }) => reviewPanelService.getPanel(panelId),
      listPanels: ({ taskId }) => reviewPanelService.listPanels(taskId),
    },
    prompts: {
      list: (request = {}) => {
        const repoRoot = repoRootFor(request.workspaceId)
        return repoRoot.ok ? promptTemplates.listTemplates(repoRoot.data) : repoRoot
      },
      render: (request) => {
        const repoRoot = repoRootFor(request.workspaceId)
        return repoRoot.ok
          ? promptTemplates.render({ name: request.name, context: request.context }, repoRoot.data)
          : repoRoot
      },
    },
    workflow: {
      listDefinitions: (request) => {
        const repoRoot = repoRootFor(request.workspaceId)
        if (!repoRoot.ok) return repoRoot
        // request.workspaceId is required, so repoRootFor resolved a path.
        return workflowDefinitions.list(repoRoot.data as string)
      },
      loadDefinition: (request) => {
        const repoRoot = repoRootFor(request.workspaceId)
        if (!repoRoot.ok) return repoRoot
        return workflowDefinitions.load(repoRoot.data as string, request.definitionId)
      },
      listRuns: (request = {}) => workflowRunStore.listRuns(request),
      getRun: ({ runId }) => workflowRunStore.getRun(runId),
      // P0-4: begin() returns as soon as the pass is running — start() would
      // park on suspended steps (checkpoint / criteria-gate / review-panel)
      // and keep the ipcRenderer.invoke pending forever. Pass progress flows
      // through workflow.run_updated / workflow.step_updated events.
      startRun: (request) =>
        Promise.resolve(
          workflowEngine.begin(request.runId, {
            workspaceId: request.workspaceId,
            ...(request.worktreeId === undefined ? {} : { worktreeId: request.worktreeId }),
          }),
        ),
      cancelRun: ({ runId }) => workflowEngine.cancel(runId),
      completeRun: ({ runId }) => workflowEngine.complete(runId),
      resolveStep: ({ stepId, outcome, result }) =>
        workflowEngine.resolveStep(stepId, {
          ...(outcome === undefined ? {} : { outcome }),
          ...(result === undefined ? {} : { result }),
        }),
      dispatch: (request) => dispatchService.dispatch(request),
      iterate: (request) => iterationController.iterate(request),
      startFullWorkflow: (request) => fullWorkflow.start(request),
      runSummary: (request) => fullWorkflow.summary(request),
    },
    recovery: {
      list: (request) => recoveryCenter.list(request),
    },
    git: {
      status: ({ workspaceId }) => gitManager.status(workspaceId),
      branch: ({ workspaceId }) => gitManager.branch(workspaceId),
      diff: (request) => gitManager.diff(request),
      log: (request) => gitManager.log(request),
      commit: (request) => gitManager.commit(request),
      changes: ({ workspaceId }) => diffService.get(workspaceId),
      filePatch: ({ workspaceId, path }) => diffService.getFilePatch(workspaceId, path),
      openFile: (request) => gitManager.openFile(request),
    },
    worktree: {
      create: (request) => worktreeManager.create(request),
      list: (request) => worktreeManager.list(request),
      validate: (request) => worktreeManager.validate(request),
      preflight: (request) => mergePreflight.check(request),
      merge: (request) => mergeService.merge(request),
      discard: (request) => worktreeManager.discard(request),
      archive: (request) => worktreeManager.archive(request),
      cleanup: (request) => worktreeManager.cleanup(request),
    },
    maintenance: {
      planRetention: (request = {}) => retentionService.plan(request),
      runRetention: (request = {}) => retentionService.run(request),
      cancelRetention: () => retentionService.cancel(),
    },
    agent: {
      listDefinitions: () => ({ ok: true, data: registeredAgents.data.list() }),
      detect: (request) => agentDetector.detect(request),
      listDetections: (request) => agentDetector.list(request),
      checkHealth: (request) => agentHealth.check(request),
      listHealth: (request) => agentHealth.list(request),
      getExecutableOverride: (request) => agentDetector.getExecutableOverride(request),
      setExecutableOverride: (request) => agentDetector.setExecutableOverride(request),
      start: (request) => agentManager.start(request),
      startReview: (request) => reviewerService.startReview(request),
      resume: (request) => resumeService.resume(request),
      send: (request) => agentManager.send(request),
      resize: (request) => agentManager.resize(request),
      cancel: ({ runId }) => agentManager.cancel(runId),
      get: ({ runId }) => agentManager.get(runId),
      list: (request = {}) => agentManager.list(request),
      getOutput: ({ runId, tailBytes }) =>
        agentManager.getOutput(runId, tailBytes === undefined ? undefined : { tailBytes }),
    },
    account: {
      list: (request = {}) => accountProfileManager.list(request),
      get: ({ id }) => accountProfileManager.get(id),
      create: (request) => accountProfileManager.create(request),
      update: ({ id, patch }) => accountProfileManager.update(id, patch),
      remove: ({ id, deleteHome }) =>
        accountProfileManager.remove(id, deleteHome === undefined ? {} : { deleteHome }),
      enable: ({ id }) => accountProfileManager.enable(id),
      setDefault: ({ agentId, profileId }) => accountProfileManager.setDefault(agentId, profileId),
      getDefault: ({ agentId }) => accountProfileManager.getDefault(agentId),
    },
    workspace: {
      create: (request) => workspaceManager.create(request),
      open: (request) => workspaceManager.open(request),
      remove: ({ id }) => workspaceManager.remove(id),
      listRecent: (request = {}) => workspaceManager.listRecent(request.limit),
      validate: (request) => workspaceManager.validate(request),
      selectDirectory: async () => {
        if (options.selectDirectory === undefined) {
          return {
            ok: false,
            error: {
              code: 'CAPABILITY_NOT_AVAILABLE',
              message: 'The folder picker is unavailable in this environment.',
              retryable: false,
            },
          }
        }
        try {
          return { ok: true, data: await options.selectDirectory() }
        } catch (cause) {
          getLogger('app').error({ cause }, 'Failed to open the workspace folder picker.')
          return {
            ok: false,
            error: {
              code: 'UNKNOWN',
              message: 'The folder picker could not be opened.',
              retryable: true,
            },
          }
        }
      },
    },
    terminal: {
      create: (request) => terminalManager.create(request),
      write: ({ terminalId, data }) => terminalManager.write(terminalId, data),
      resize: ({ terminalId, cols, rows }) => terminalManager.resize(terminalId, cols, rows),
      close: ({ terminalId }) => terminalManager.close(terminalId),
      get: ({ terminalId }) => ({ ok: true, data: terminalManager.get(terminalId) ?? null }),
      list: (request = {}) => ({ ok: true, data: terminalManager.list(request.workspaceId) }),
    },
    system: {
      info: () => ({
        ok: true,
        data: {
          appVersion: options.appVersion ?? APP_VERSION,
          runtimeVersion: options.runtimeVersion ?? process.versions.node,
        },
      }),
      paths: () => {
        const logs = paths.logs()
        if (!logs.ok) {
          return logs
        }
        return {
          ok: true,
          data: {
            dataDirectory: paths.home(),
            logDirectory: logs.data,
            databaseFile: database.filePath,
          },
        }
      },
      health: async () => {
        const issues: PublicAppError[] = []
        const environment = await wsl.inspect()
        if (!environment.ok) {
          issues.push(environment.error)
        }
        const health: SystemHealth = {
          databaseAvailable: database.connection.open,
          wslAvailable: environment.ok,
          issues,
        }
        return { ok: true, data: health }
      },
      inspectWsl: () => wsl.inspect(),
      listWslDistributions: () => wsl.listDistributions(),
      getDefaultWslDistribution: () => wsl.getDefaultDistribution(),
      setDefaultWslDistribution: (name) => wsl.setDefaultDistribution(name),
      doctor: (request) => doctor.run(request),
    },
    credential: {
      status: () => ({ ok: true, data: { available: credentials.isAvailable() } }),
      set: ({ key, value }) => credentials.set(key, value),
      delete: ({ key }) => credentials.delete(key),
      list: () => credentials.list(),
    },
    settings: {
      resolveConfig: (request = {}) => config.resolve(request),
      updateConfig: (request) => {
        if (request.layer === 'global') {
          return config.updateGlobal(request.patch)
        }
        if (request.workspaceId === undefined) {
          return {
            ok: false,
            error: {
              code: 'VALIDATION_FAILED',
              message: 'A workspace is required for workspace settings.',
              retryable: false,
            },
          }
        }
        return config.updateWorkspace(request.workspaceId, request.patch)
      },
      openDirectory: async ({ kind }) => {
        if (options.openPath === undefined) {
          return {
            ok: false,
            error: {
              code: 'CAPABILITY_NOT_AVAILABLE',
              message: 'Opening folders is unavailable in this environment.',
              retryable: false,
            },
          }
        }
        const directory = kind === 'logs' ? paths.logs() : { ok: true as const, data: paths.home() }
        if (!directory.ok) return directory
        try {
          const failure = await options.openPath(directory.data)
          if (failure.length > 0) {
            return {
              ok: false,
              error: {
                code: 'UNKNOWN',
                message: 'The folder could not be opened.',
                retryable: true,
              },
            }
          }
          return { ok: true, data: undefined }
        } catch (cause) {
          getLogger('app').error({ cause, path: directory.data }, 'Failed to open Settings folder.')
          return {
            ok: false,
            error: {
              code: 'UNKNOWN',
              message: 'The folder could not be opened.',
              retryable: true,
            },
          }
        }
      },
    },
    async dispose() {
      if (disposed) {
        return { ok: true, data: undefined }
      }
      disposed = true
      // P2-1/P2-2: stop the workflow/maintenance layer first, awaiting every
      // cancel, so no in-flight loop, dispatch, or GC keeps writing to the
      // database after it closes below.
      await retentionService.dispose()
      await workflowEngine.dispose()
      await fullWorkflowEngine.dispose()
      await dispatchService.dispose()
      await iterationController.dispose()
      await fullWorkflow.dispose()
      permissionManager.dispose()
      // P0-2: stop every child process before the EventBus is cleared and the
      // database closes — Agent runs first (their exit path settles terminal
      // status and collects handoffs), then terminals, then the backstop for
      // anything still registered with the ProcessManager.
      await agentManager.dispose()
      // Belt and braces: compose owns the shared RunLogStore — make sure its
      // throttled writes are fsynced and handles released even if the Agent
      // manager's own shutdown path bailed out early.
      runLogs.disposeAll()
      reviewerService.dispose()
      reviewPanelService.dispose()
      await terminalManager.dispose()
      autoCommit.dispose()
      const processes = await processManager.disposeAll()
      if (processes.ok && processes.data.failed.length > 0) {
        getLogger('runtime').error(
          { failed: processes.data.failed },
          'Some processes did not stop cleanly during shutdown.',
        )
      }
      events.clear()
      return database.close()
    },
  }

  return { ok: true, data: runtime }
}
