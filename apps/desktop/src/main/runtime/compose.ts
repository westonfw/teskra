import type {
  IpcResult,
  PublicAppError,
  SystemHealth,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'

import { createConfigService } from '../config/config-service'
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
import { getLogger, initializeLogging } from '../logger'
import { createTeskraPaths, type TeskraPaths } from '../paths'
import { createCommandRunner, type CommandRunner } from '../process/command-runner'
import { createProcessManager } from '../process/process-manager'
import { createTerminalManager } from '../terminal/terminal-manager'
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

  let disposed = false
  const runtime: TeskraRuntime = {
    workspace: {
      create: (request) => workspaceManager.create(request),
      open: (request) => workspaceManager.open(request),
      remove: ({ id }) => workspaceManager.remove(id),
      listRecent: (request = {}) => workspaceManager.listRecent(request.limit),
      validate: (request) => workspaceManager.validate(request),
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
    dispose() {
      if (disposed) {
        return { ok: true, data: undefined }
      }
      disposed = true
      terminalManager.dispose()
      events.clear()
      return database.close()
    },
  }

  return { ok: true, data: runtime }
}
