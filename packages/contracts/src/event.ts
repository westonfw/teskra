import type { DiffResult } from './git'
import type { PublicAppError } from './error'

/**
 * plan §18 — EventBus event map. Type-only: payloads cross to the Renderer
 * via webContents.send (§19 RendererEventBridge) and are re-validated at the
 * IPC boundary when needed.
 */
export interface WorkbenchEvents {
  'workspace.opened': {
    workspaceId: string
  }

  'terminal.created': {
    terminalId: string
    workspaceId: string
  }
  'terminal.output': {
    terminalId: string
    data: string
  }
  'terminal.closed': {
    terminalId: string
  }

  'agent.created': {
    runId: string
  }
  'agent.started': {
    runId: string
  }
  'agent.output': {
    runId: string
    data: string
  }
  'agent.command': {
    runId: string
    command: string
  }
  'agent.waiting': {
    runId: string
    reason: 'user' | 'permission' | 'agent'
  }
  'agent.completed': {
    runId: string
    exitCode: number
  }
  'agent.failed': {
    runId: string
    error: PublicAppError
  }

  'task.created': {
    taskId: string
    workspaceId: string
  }
  'task.updated': {
    taskId: string
  }

  'git.changed': {
    workspaceId: string
  }
  'git.diff.updated': {
    runId: string
    diff: DiffResult
  }

  'permission.requested': {
    runId: string
    command: string
  }
  'permission.resolved': {
    runId: string
    command: string
  }
}

export type WorkbenchEventName = keyof WorkbenchEvents
