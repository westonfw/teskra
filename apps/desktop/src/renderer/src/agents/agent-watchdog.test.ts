import { describe, expect, it } from 'vitest'

import type { AgentRun } from '@teskra/contracts'

import { restartAgentRunRequest, shortDuration } from './agent-watchdog'

const run: AgentRun = {
  id: 'run-1',
  taskId: 'task-1',
  workspaceId: 'workspace-1',
  agentType: 'fake',
  role: 'implementer',
  model: 'test-model',
  approvalMode: 'manual',
  status: 'running',
  worktreeId: 'worktree-1',
  executionMode: 'orchestrated',
  runDir: '/runs/run-1',
  prompt: 'Keep working',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:01.000Z',
}

describe('Agent watchdog actions (TASK-085)', () => {
  it('restarts with the original Run choices but a fresh interactive lifecycle', () => {
    expect(restartAgentRunRequest(run)).toEqual({
      workspaceId: 'workspace-1',
      agentType: 'fake',
      taskId: 'task-1',
      role: 'implementer',
      model: 'test-model',
      approvalMode: 'manual',
      executionMode: 'orchestrated',
      worktreeId: 'worktree-1',
      prompt: 'Keep working',
      mode: 'interactive',
    })
  })

  it('formats the stalled duration for the UI', () => {
    expect(shortDuration(12 * 60_000)).toBe('12m')
    expect(shortDuration(72 * 60_000)).toBe('1h 12m')
  })
})
