import { randomUUID } from 'node:crypto'

import type {
  CreateTerminalRequest,
  IpcResult,
  TerminalSession,
  TerminalShell,
  WorkbenchEvents,
  Workspace,
} from '@teskra/contracts'

import { createAgentOutputBatcher } from '../agents/agent-output-batcher'
import type { WorkspaceRepository } from '../db/repositories'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { ProcessManager } from '../process/process-manager'
import { resolveEnvReferencesBestEffort, type CredentialStore } from '../security/credential-store'
import { createWorkspaceRuntime, type WorkspaceRuntime } from '../workspace/runtime'

type TerminalProcesses = Pick<ProcessManager, 'start' | 'write' | 'resize' | 'stop'>

export interface TerminalManager {
  create(request: CreateTerminalRequest): IpcResult<TerminalSession>
  write(terminalId: string, data: string): IpcResult<void>
  resize(terminalId: string, cols: number, rows: number): IpcResult<void>
  close(terminalId: string): Promise<IpcResult<void>>
  get(terminalId: string): TerminalSession | undefined
  list(workspaceId?: string): readonly TerminalSession[]
  /** Stops every active terminal process (P0-2 shutdown), then unsubscribes. */
  dispose(): Promise<void>
}

export interface TerminalManagerDeps {
  readonly processes: TerminalProcesses
  readonly events: EventBus<WorkbenchEvents>
  readonly workspaces: Pick<WorkspaceRepository, 'getById'>
  readonly resolveRuntime?: (workspace: Workspace) => IpcResult<WorkspaceRuntime>
  readonly now?: () => string
  readonly createId?: () => string
  /** Coalescing window for terminal.output forwarding; defaults to 32ms. */
  readonly outputBatchMs?: number
  /**
   * TASK-088: workspace env secret refs are resolved through the Credential
   * Store for the terminal process. Unresolvable secrets are omitted (logged
   * by key name) rather than blocking terminal creation.
   */
  readonly credentials?: CredentialStore
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
    messageKey: 'errorMessage.terminalNotActive',
    params: { id: terminalId },
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

  // P1-2: bursty PTY fragments (hundreds per second under `npm install`) are
  // coalesced into one terminal.output per animation-scale window, matching
  // the AgentOutputBatcher pattern used for agent runs.
  const outputBatcher = createAgentOutputBatcher(
    (terminalId, data) => deps.events.emit('terminal.output', { terminalId, data }),
    deps.outputBatchMs,
  )

  const closeSession = (terminalId: string): void => {
    const session = sessions.get(terminalId)
    if (session === undefined) {
      return
    }
    // Deliver still-buffered output before terminal.closed so the replay
    // order (output tail, then exit) survives batching.
    outputBatcher.flush(terminalId)
    sessions.delete(terminalId)
    terminalByProcess.delete(session.processId)
    deps.events.emit('terminal.closed', { terminalId })
  }

  const unsubscribeOutput = deps.events.subscribe('process.output', ({ processId, data }) => {
    const terminalId = terminalByProcess.get(processId)
    if (terminalId !== undefined) {
      outputBatcher.push(terminalId, data)
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
          messageKey: 'errorMessage.workspaceNotFound',
          params: { id: request.workspaceId },
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
        env:
          workspace.data.env === undefined
            ? undefined
            : resolveEnvReferencesBestEffort(workspace.data.env, deps.credentials, {
                workspaceId: workspace.data.id,
              }),
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

    async dispose() {
      // P0-2: quitting must not leak terminal processes. Stop each session
      // through the interrupt → terminate → kill ladder while the event
      // subscriptions are still live, so process.exited closes sessions (and
      // emits terminal.closed) instead of leaving stale state behind.
      await Promise.all(
        [...sessions.values()].map(async (session) => {
          const stopped = await deps.processes.stop(session.processId)
          if (!stopped.ok) {
            getLogger('process').error(
              { terminalId: session.id, error: stopped.error },
              'Failed to stop a terminal during shutdown.',
            )
            closeSession(session.id)
          }
        }),
      )
      outputBatcher.flushAll()
      unsubscribeOutput()
      unsubscribeExit()
      sessions.clear()
      terminalByProcess.clear()
    },
  }

  return manager
}
