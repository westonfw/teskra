import type { DiffResult } from './git'
import type { PublicAppError } from './error'

/**
 * plan §18 — EventBus event map. Type-only: payloads cross to the Renderer
 * via webContents.send (§19 RendererEventBridge) and are re-validated at the
 * IPC boundary when needed.
 */
export interface WorkbenchEvents {
  'process.started': {
    processId: string
    pid: number
    workspaceId?: string
    agentRunId?: string
  }
  'process.output': {
    processId: string
    data: string
    agentRunId?: string
  }
  'process.exited': {
    processId: string
    exitCode: number
    signal?: number
    agentRunId?: string
  }

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
  'agent.queued': {
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
  /** TASK-087: the run's worktree changes were auto-committed (never pushed). */
  'agent.committed': {
    runId: string
    worktreeId: string
    commitHash: string
  }
  'agent.failed': {
    runId: string
    error: PublicAppError
  }
  'agent.cancelled': {
    runId: string
  }
  'agent.interrupted': {
    runId: string
    reason: 'process_dead' | 'workspace_missing' | 'worktree_broken'
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

  /** TASK-046: merge kept the conflict scene; worktree state is 'conflict'. */
  'worktree.merge_conflict': {
    worktreeId: string
    workspaceId: string
    runId?: string
    branch: string
    baseBranch: string
    conflicts: string[]
  }
  /** TASK-046: the agent branch merged into its base; the branch is kept. */
  'worktree.merged': {
    worktreeId: string
    workspaceId: string
    runId?: string
    branch: string
    baseBranch: string
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

export const WORKBENCH_EVENT_NAMES = [
  'process.started',
  'process.output',
  'process.exited',
  'workspace.opened',
  'terminal.created',
  'terminal.output',
  'terminal.closed',
  'agent.created',
  'agent.queued',
  'agent.started',
  'agent.output',
  'agent.command',
  'agent.waiting',
  'agent.completed',
  'agent.committed',
  'agent.failed',
  'agent.cancelled',
  'agent.interrupted',
  'task.created',
  'task.updated',
  'git.changed',
  'git.diff.updated',
  'worktree.merge_conflict',
  'worktree.merged',
  'permission.requested',
  'permission.resolved',
] as const satisfies readonly WorkbenchEventName[]

export const RENDERER_EVENT_CHANNEL = 'teskra:event' as const

export type WorkbenchEventEnvelope<Name extends WorkbenchEventName = WorkbenchEventName> = {
  [EventName in Name]: { name: EventName; payload: WorkbenchEvents[EventName] }
}[Name]
