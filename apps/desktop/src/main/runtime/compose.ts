import { resolve } from 'node:path'

import type {
  IpcResult,
  PublicAppError,
  SystemHealth,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'

import { createConfigService } from '../config/config-service'
import { createAgentDetector } from '../agents/agent-detector'
import { createAgentHealthManager } from '../agents/agent-health-manager'
import { createAgentManager } from '../agents/agent-manager'
import { createDefaultAgentRegistry } from '../agents/agent-registry'
import { createClaudeAdapter } from '../agents/adapters/claude-adapter'
import { createCodexAdapter } from '../agents/adapters/codex-adapter'
import { createFakeAgentAdapter } from '../agents/adapters/fake-agent-adapter'
import { openDatabase, type TeskraDatabase } from '../db'
import { migrateDatabase } from '../db/migrations'
import {
  createAgentEventRepository,
  createAgentRunRepository,
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
import { createGitManager } from '../git/git-manager'
import { getLogger, initializeLogging } from '../logger'
import { createTeskraPaths, type TeskraPaths } from '../paths'
import { createCommandRunner, type CommandRunner } from '../process/command-runner'
import { createProcessManager } from '../process/process-manager'
import { createTerminalManager } from '../terminal/terminal-manager'
import { createTaskManager } from '../tasks/task-manager'
import { createWorkspaceRuntime, type WslEnvironmentInfo } from '../workspace/runtime'
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
}

function createRepositories(connection: TeskraDatabase['connection']) {
  return {
    workspaces: createWorkspaceRepository(connection),
    tasks: createTaskRepository(connection),
    agentRuns: createAgentRunRepository(connection),
    agentEvents: createAgentEventRepository(connection),
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
  const workspaceManager = createWorkspaceManager(repositories.workspaces, {
    createRuntime: runtimeFor,
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
  })
  const taskManager = createTaskManager({
    tasks: repositories.tasks,
    workspaces: repositories.workspaces,
    events,
  })
  const gitManager = createGitManager({
    commands,
    workspaces: repositories.workspaces,
    events,
    resolveRuntime: (workspace) => runtimeFor(workspace.runtime),
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
  const adapterOptions = {
    processes: processManager,
    detector: agentDetector,
    resolveRuntime: runtimeFor,
  }
  const agentManager = createAgentManager({
    registry: registeredAgents.data,
    adapters: [
      createCodexAdapter(adapterOptions),
      createClaudeAdapter(adapterOptions),
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
    workspaces: repositories.workspaces,
    tasks: repositories.tasks,
    worktrees: repositories.worktrees,
    events,
    paths,
    resolveConcurrency: (workspaceId) => {
      const resolved = config.resolve({ workspaceId })
      return resolved.ok ? { ok: true, data: resolved.data.config.concurrency } : resolved
    },
  })

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
    git: {
      status: ({ workspaceId }) => gitManager.status(workspaceId),
      branch: ({ workspaceId }) => gitManager.branch(workspaceId),
      diff: (request) => gitManager.diff(request),
      log: (request) => gitManager.log(request),
      commit: (request) => gitManager.commit(request),
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
      send: (request) => agentManager.send(request),
      cancel: ({ runId }) => agentManager.cancel(runId),
      get: ({ runId }) => agentManager.get(runId),
      list: (request = {}) => agentManager.list(request),
      getOutput: ({ runId }) => agentManager.getOutput(runId),
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
          appVersion: options.appVersion ?? '0.1.0',
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
    dispose() {
      if (disposed) {
        return { ok: true, data: undefined }
      }
      disposed = true
      agentManager.dispose()
      terminalManager.dispose()
      events.clear()
      return database.close()
    },
  }

  return { ok: true, data: runtime }
}
