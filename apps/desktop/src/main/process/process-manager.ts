import type { IPty } from 'node-pty'
import { spawn as spawnPty } from 'node-pty'

import type { IpcResult, WorkbenchEvents } from '@teskra/contracts'

import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'
import { getLogger } from '../logger'
import type { ShellExecutionContext, WorkspaceRuntime } from '../workspace/runtime'

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30

export interface ProcessStartRequest {
  readonly id: string
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly cols?: number
  readonly rows?: number
  readonly terminalName?: string
  readonly workspaceId?: string
  readonly agentRunId?: string
  readonly runtime: WorkspaceRuntime
}

export interface ManagedProcess {
  readonly id: string
  readonly pid: number
  readonly workspaceId?: string
  readonly agentRunId?: string
  readonly startedAt: string
}

export interface ProcessExit {
  readonly processId: string
  readonly exitCode: number
  readonly signal?: number
}

export interface KillPolicy {
  readonly interruptTimeoutMs: number
  readonly terminateTimeoutMs: number
  readonly forceKillTimeoutMs: number
}

export const DEFAULT_KILL_POLICY: KillPolicy = {
  interruptTimeoutMs: 1_000,
  terminateTimeoutMs: 2_000,
  forceKillTimeoutMs: 1_000,
}

export interface ProcessStopResult {
  readonly exit: ProcessExit
  readonly stage: 'interrupt' | 'terminate' | 'kill'
}

export interface ProcessManager {
  start(request: ProcessStartRequest): IpcResult<ManagedProcess>
  write(processId: string, data: string): IpcResult<void>
  resize(processId: string, cols: number, rows: number): IpcResult<void>
  interrupt(processId: string): IpcResult<void>
  terminate(processId: string): IpcResult<void>
  kill(processId: string): IpcResult<void>
  stop(processId: string, policy?: KillPolicy): Promise<IpcResult<ProcessStopResult>>
  get(processId: string): ManagedProcess | undefined
  list(): readonly ManagedProcess[]
  waitForExit(processId: string): Promise<IpcResult<ProcessExit>>
}

export interface ProcessManagerDeps {
  readonly events: EventBus<WorkbenchEvents>
  /** Native seam for deterministic tests; production always uses node-pty. */
  readonly spawn?: typeof spawnPty
  readonly hostPlatform?: NodeJS.Platform
  readonly now?: () => string
}

interface ActiveProcess {
  readonly info: ManagedProcess
  readonly pty: IPty
  readonly exited: Promise<ProcessExit>
  resolveExit(exit: ProcessExit): void
  exitEmitted: boolean
  disposeData(): void
  disposeExit(): void
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function validDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function validTimeout(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function waitWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    void promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

function processNotFound<T>(processId: string): IpcResult<T> {
  return fail({
    code: 'PROCESS_NOT_FOUND',
    message: `Process "${processId}" is not active.`,
    retryable: false,
    detail: `process registry has no active entry for ${JSON.stringify(processId)}`,
  })
}

function publicInfo(request: ProcessStartRequest, pid: number, startedAt: string): ManagedProcess {
  return {
    id: request.id,
    pid,
    ...(request.workspaceId !== undefined ? { workspaceId: request.workspaceId } : {}),
    ...(request.agentRunId !== undefined ? { agentRunId: request.agentRunId } : {}),
    startedAt,
  }
}

function toPtyContext(request: ProcessStartRequest): ShellExecutionContext {
  return request.runtime.resolveCommand(request.command, request.args ?? [], request.cwd)
}

/**
 * The sole interactive-process / PTY authority (TASK-014).
 * CommandRunner remains the separate authority for bounded one-shot commands.
 */
export function createProcessManager(deps: ProcessManagerDeps): ProcessManager {
  const active = new Map<string, ActiveProcess>()
  const spawn = deps.spawn ?? spawnPty
  const hostPlatform = deps.hostPlatform ?? process.platform
  const now = deps.now ?? (() => new Date().toISOString())
  const logger = getLogger('process')

  const getActive = (processId: string): IpcResult<ActiveProcess> => {
    const entry = active.get(processId)
    return entry === undefined ? processNotFound(processId) : { ok: true, data: entry }
  }

  const invoke = (
    processId: string,
    operation: string,
    action: (entry: ActiveProcess) => void,
  ): IpcResult<void> => {
    const entry = getActive(processId)
    if (!entry.ok) {
      return entry
    }
    try {
      action(entry.data)
      return { ok: true, data: undefined }
    } catch (cause) {
      return fail({
        code: 'UNKNOWN',
        message: `Failed to ${operation} process "${processId}".`,
        retryable: true,
        detail: `${operation} failed for pid ${String(entry.data.info.pid)}`,
        cause,
      })
    }
  }

  const manager: ProcessManager = {
    start(request) {
      if (request.id.trim().length === 0 || request.command.trim().length === 0) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Process id and command are required.',
          retryable: false,
          detail: `id=${JSON.stringify(request.id)} command=${JSON.stringify(request.command)}`,
        })
      }
      if (active.has(request.id)) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: `Process id "${request.id}" is already active.`,
          retryable: false,
          detail: `duplicate active process id ${JSON.stringify(request.id)}`,
        })
      }
      const cols = request.cols ?? DEFAULT_COLS
      const rows = request.rows ?? DEFAULT_ROWS
      if (!validDimension(cols) || !validDimension(rows)) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'PTY dimensions must be positive integers.',
          retryable: false,
          detail: `cols=${String(cols)} rows=${String(rows)}`,
        })
      }
      const runtimeStatus = request.runtime.validate()
      if (!runtimeStatus.ok) {
        return runtimeStatus
      }

      const context = toPtyContext(request)
      let terminal: IPty
      try {
        terminal = spawn(context.executable, [...context.args], {
          name: request.terminalName ?? 'xterm-256color',
          cols,
          rows,
          ...(context.cwd !== undefined ? { cwd: context.cwd } : {}),
          env: { ...process.env, ...request.env },
          useConpty: true,
        })
      } catch (cause) {
        return fail({
          code: 'UNKNOWN',
          message: `Failed to start process "${request.id}".`,
          retryable: false,
          detail: `${context.executable} ${context.args.join(' ')}`,
          cause,
        })
      }

      const info = publicInfo(request, terminal.pid, now())
      let resolveExit!: (exit: ProcessExit) => void
      const exited = new Promise<ProcessExit>((resolve) => {
        resolveExit = resolve
      })
      const entry: ActiveProcess = {
        info,
        pty: terminal,
        exited,
        resolveExit,
        exitEmitted: false,
        disposeData: () => undefined,
        disposeExit: () => undefined,
      }
      const dataSubscription = terminal.onData((data) => {
        deps.events.emit('process.output', { processId: request.id, data })
      })
      entry.disposeData = () => dataSubscription.dispose()
      const exitSubscription = terminal.onExit(({ exitCode, signal }) => {
        if (entry.exitEmitted) {
          return
        }
        entry.exitEmitted = true
        entry.disposeData()
        entry.disposeExit()
        if (active.get(request.id) === entry) {
          active.delete(request.id)
        }
        const exit: ProcessExit = {
          processId: request.id,
          exitCode,
          ...(signal !== undefined ? { signal } : {}),
        }
        entry.resolveExit(exit)
        deps.events.emit('process.exited', exit)
        logger.debug({ processId: request.id, pid: terminal.pid, exitCode, signal }, 'PTY exited')
      })
      entry.disposeExit = () => exitSubscription.dispose()
      active.set(request.id, entry)
      deps.events.emit('process.started', {
        processId: request.id,
        pid: terminal.pid,
        ...(request.workspaceId !== undefined ? { workspaceId: request.workspaceId } : {}),
        ...(request.agentRunId !== undefined ? { agentRunId: request.agentRunId } : {}),
      })
      return { ok: true, data: info }
    },

    write(processId, data) {
      return invoke(processId, 'write to', (entry) => entry.pty.write(data))
    },

    resize(processId, cols, rows) {
      if (!validDimension(cols) || !validDimension(rows)) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'PTY dimensions must be positive integers.',
          retryable: false,
          detail: `cols=${String(cols)} rows=${String(rows)}`,
        })
      }
      return invoke(processId, 'resize', (entry) => entry.pty.resize(cols, rows))
    },

    interrupt(processId) {
      return invoke(processId, 'interrupt', (entry) => entry.pty.write('\u0003'))
    },

    terminate(processId) {
      return invoke(processId, 'terminate', (entry) => {
        if (hostPlatform === 'win32') {
          entry.pty.kill()
        } else {
          entry.pty.kill('SIGTERM')
        }
      })
    },

    kill(processId) {
      return invoke(processId, 'kill', (entry) => {
        if (hostPlatform === 'win32') {
          entry.pty.kill()
        } else {
          entry.pty.kill('SIGKILL')
        }
      })
    },

    async stop(processId, policy = DEFAULT_KILL_POLICY) {
      if (
        !validTimeout(policy.interruptTimeoutMs) ||
        !validTimeout(policy.terminateTimeoutMs) ||
        !validTimeout(policy.forceKillTimeoutMs)
      ) {
        return fail({
          code: 'VALIDATION_FAILED',
          message: 'Every process stop timeout must be a positive integer.',
          retryable: false,
          detail: `kill policy: ${JSON.stringify(policy)}`,
        })
      }
      const entry = getActive(processId)
      if (!entry.ok) {
        return entry
      }
      const exited = entry.data.exited

      const interrupted = manager.interrupt(processId)
      if (!interrupted.ok) {
        return interrupted
      }
      let exit = await waitWithin(exited, policy.interruptTimeoutMs)
      if (exit !== undefined) {
        return { ok: true, data: { exit, stage: 'interrupt' } }
      }

      const terminated = manager.terminate(processId)
      if (!terminated.ok) {
        return terminated
      }
      exit = await waitWithin(exited, policy.terminateTimeoutMs)
      if (exit !== undefined) {
        return { ok: true, data: { exit, stage: 'terminate' } }
      }

      const killed = manager.kill(processId)
      if (!killed.ok) {
        return killed
      }
      exit = await waitWithin(exited, policy.forceKillTimeoutMs)
      if (exit !== undefined) {
        return { ok: true, data: { exit, stage: 'kill' } }
      }

      return fail({
        code: 'COMMAND_TIMEOUT',
        message: `Process "${processId}" did not exit after force kill.`,
        retryable: true,
        detail: `pid ${String(entry.data.info.pid)} remained active after kill policy ${JSON.stringify(policy)}`,
      })
    },

    get(processId) {
      return active.get(processId)?.info
    },

    list() {
      return [...active.values()].map((entry) => entry.info)
    },

    async waitForExit(processId) {
      const entry = getActive(processId)
      if (!entry.ok) {
        return entry
      }
      return { ok: true, data: await entry.data.exited }
    },
  }

  return manager
}
