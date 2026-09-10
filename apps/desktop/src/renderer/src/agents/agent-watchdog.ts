import type { AgentRun, StartAgentRunRequest } from '@teskra/contracts'

/** Preserve the user's Run choices while always creating a fresh interactive Run. */
export function restartAgentRunRequest(run: AgentRun): StartAgentRunRequest {
  return {
    workspaceId: run.workspaceId,
    agentType: run.agentType,
    taskId: run.taskId,
    role: run.role,
    model: run.model,
    approvalMode: run.approvalMode,
    executionMode: run.executionMode,
    worktreeId: run.worktreeId,
    prompt: run.prompt,
    mode: 'interactive',
  }
}

export function shortDuration(durationMs: number): string {
  const minutes = Math.floor(durationMs / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
