import { randomUUID } from 'node:crypto'

import type {
  CreateTerminalRequest,
  IpcResult,
  TerminalSession,
  TerminalShell,
  WorkbenchEvents,
  Workspace,
} from '@teskra/contracts'

import type { WorkspaceRepository } from '../db/repositories'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import type { ProcessManager } from '../process/process-manager'
import { createWorkspaceRuntime, type WorkspaceRuntime } from '../workspace/runtime'

type TerminalProcesses = Pick<ProcessManager, 'start' | 'write' | 'resize' | 'stop'>

export interface TerminalManager {
  create(request: CreateTerminalRequest): IpcResult<TerminalSession>
  write(terminalId: string, data: string): IpcResult<void>
  resize(terminalId: string, cols: number, rows: number): IpcResult<void>
  close(terminalId: string): Promise<IpcResult<void>>
  get(terminalId: string): TerminalSession | undefined
  list(workspaceId?: string): readonly TerminalSession[]
  /** Unsubscribes from the shared EventBus; it does not kill active terminals. */
  dispose(): void
}

export interface TerminalManagerDeps {
  readonly processes: TerminalProcesses
  readonly events: EventBus<WorkbenchEvents>
  readonly workspaces: Pick<WorkspaceRepository, 'getById'>
  readonly resolveRuntime?: (workspace: Workspace) => IpcResult<WorkspaceRuntime>
  readonly now?: () => string
  readonly createId?: () => string
}

const DEFAULT_TITLES: Record<TerminalShell, string> = {
  powershell: 'PowerShell',
  cmd: 'Command Prompt',
  wsl: 'WSL',
  bash: 'Bash',
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function terminalNotFound<T>(terminalId: string): IpcResult<T> {
  return fail({
    code: 'TERMINAL_NOT_FOUND',
    message: `Terminal "${terminalId}" is not active.`,
    retryable: false,
    detail: `terminal registry has no entry for ${JSON.stringify(terminalId)}`,
  })
}

/** TerminalSession lifecycle, deliberately separate from AgentRun (TASK-017). */
export function createTerminalManager(deps: TerminalManagerDeps): TerminalManager {
  const sessions = new Map<string, TerminalSession>()
  const terminalByProcess = new Map<string, string>()
  const now = deps.now ?? (() => new Date().toISOString())
  const createId = deps.createId ?? randomUUID
  const resolveRuntime =
    deps.resolveRuntime ?? ((workspace: Workspace) => createWorkspaceRuntime(workspace.runtime))

  const closeSession = (terminalId: string): void => {
    const session = sessions.get(terminalId)
    if (session === undefined) {
      return
    }
    sessions.delete(terminalId)
    terminalByProcess.delete(session.processId)
    deps.events.emit('terminal.closed', { terminalId })
  }

  const unsubscribeOutput = deps.events.subscribe('process.output', ({ processId, data }) => {
    const terminalId = terminalByProcess.get(processId)
    if (terminalId !== undefined) {
      deps.events.emit('terminal.output', { terminalId, data })
    }
  })
  const unsubscribeExit = deps.events.subscribe('process.exited', ({ processId }) => {
    const terminalId = terminalByProcess.get(processId)
    if (terminalId !== undefined) {
      closeSession(terminalId)
    }
  })

  const manager: TerminalManager = {
    create(request) {
      const workspace = deps.workspaces.getById(request.workspaceId)
      if (!workspace.ok) {
        return workspace
      }
      if (workspace.data === null) {
        return fail({
          code: 'WORKSPACE_NOT_FOUND',
          message: `Workspace "${request.workspaceId}" was not found.`,
          retryable: false,
          detail: `cannot create terminal for missing workspace ${JSON.stringify(request.workspaceId)}`,
        })
      }
      const runtime = resolveRuntime(workspace.data)
      if (!runtime.ok) {
        return runtime
      }
      const launch = runtime.data.resolveTerminal(request.shell)
      if (!launch.ok) {
        return launch
      }

      const terminalId = createId()
      const processId = createId()
      const session: TerminalSession = {
        id: terminalId,
        workspaceId: request.workspaceId,
        shell: request.shell,
        processId,
        title: request.title ?? DEFAULT_TITLES[request.shell],
        createdAt: now(),
      }
      // Register before spawning so even immediate process output/exit can be
      // mapped to this terminal instead of being lost.
      sessions.set(terminalId, session)
      terminalByProcess.set(processId, terminalId)
      const started = deps.processes.start({
        id: processId,
        command: launch.data.command,
        args: launch.data.args,
        cwd: workspace.data.path,
        env: workspace.data.env,
        cols: request.cols,
        rows: request.rows,
        workspaceId: workspace.data.id,
        runtime: runtime.data,
      })
      if (!started.ok) {
        sessions.delete(terminalId)
        terminalByProcess.delete(processId)
        return started
      }
      deps.events.emit('terminal.created', {
        terminalId,
        workspaceId: workspace.data.id,
      })
      return { ok: true, data: session }
    },

    write(terminalId, data) {
      const session = sessions.get(terminalId)
      return session === undefined
        ? terminalNotFound(terminalId)
        : deps.processes.write(session.processId, data)
    },

    resize(terminalId, cols, rows) {
      const session = sessions.get(terminalId)
      return session === undefined
        ? terminalNotFound(terminalId)
        : deps.processes.resize(session.processId, cols, rows)
    },

    async close(terminalId) {
      const session = sessions.get(terminalId)
      if (session === undefined) {
        return terminalNotFound(terminalId)
      }
      const stopped = await deps.processes.stop(session.processId)
      if (!stopped.ok) {
        return stopped
      }
      closeSession(terminalId)
      return { ok: true, data: undefined }
    },

    get(terminalId) {
      return sessions.get(terminalId)
    },

    list(workspaceId) {
      const all = [...sessions.values()]
      return workspaceId === undefined
        ? all
        : all.filter((session) => session.workspaceId === workspaceId)
    },

    dispose() {
      unsubscribeOutput()
      unsubscribeExit()
    },
  }

  return manager
}
