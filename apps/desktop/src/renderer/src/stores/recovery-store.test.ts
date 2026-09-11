import type {
  RecoveryIssue,
  RecoveryReport,
  WorkbenchEventName,
  WorkbenchEvents,
} from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createRecoveryStore, type RecoveryStoreBridge } from './recovery-store'

const WORKSPACE_ID = 'workspace-1'

function issue(overrides: Partial<RecoveryIssue> = {}): RecoveryIssue {
  return {
    id: 'interrupted_run:run-1',
    kind: 'interrupted_run',
    summary: 'Run run-1 was interrupted and can be resumed.',
    suggestedAction: 'resume',
    workspaceId: WORKSPACE_ID,
    runId: 'run-1',
    ...overrides,
  }
}

function report(issues: RecoveryIssue[]): RecoveryReport {
  return { generatedAt: '2026-09-10T01:00:00.000Z', workspaceId: WORKSPACE_ID, issues }
}

function createBridge(initialIssues: RecoveryIssue[] = []) {
  const handlers = new Map<WorkbenchEventName, Set<(payload: never) => void>>()
  let issues = initialIssues
  const bridge: RecoveryStoreBridge = {
    recovery: {
      list: vi.fn(async () => ({ ok: true as const, data: report(issues) })),
    },
    agent: {
      resume: vi.fn(async ({ runId }) => {
        issues = issues.filter((item) => item.runId !== runId)
        return {
          ok: true as const,
          data: {
            id: runId,
            workspaceId: WORKSPACE_ID,
            agentType: 'codex',
            status: 'running' as const,
            executionMode: 'attended' as const,
            runDir: '/data/runs/run-1',
            createdAt: '2026-09-10T00:00:00.000Z',
            updatedAt: '2026-09-10T01:00:00.000Z',
          },
        }
      }),
    },
    worktree: {
      validate: vi.fn(async ({ worktreeId }) => {
        issues = issues.filter((item) => item.worktreeId !== worktreeId)
        return {
          ok: true as const,
          data: {
            id: worktreeId,
            workspaceId: WORKSPACE_ID,
            branch: 'agent/run-1',
            baseBranch: 'main',
            path: '/data/worktrees/ws/run-1',
            state: 'ready' as const,
            isolation: 'worktree' as const,
            createdAt: '2026-09-10T00:00:00.000Z',
            updatedAt: '2026-09-10T01:00:00.000Z',
          },
        }
      }),
      discard: vi.fn(async ({ worktreeId }) => {
        issues = issues.filter((item) => item.worktreeId !== worktreeId)
        return {
          ok: true as const,
          data: {
            id: worktreeId,
            workspaceId: WORKSPACE_ID,
            branch: 'agent/run-1',
            baseBranch: 'main',
            path: '/data/worktrees/ws/run-1',
            state: 'discarded' as const,
            isolation: 'worktree' as const,
            createdAt: '2026-09-10T00:00:00.000Z',
            updatedAt: '2026-09-10T01:00:00.000Z',
          },
        }
      }),
    },
    events: {
      subscribe: vi.fn((name: WorkbenchEventName, handler: (payload: never) => void) => {
        let listeners = handlers.get(name)
        if (listeners === undefined) {
          listeners = new Set()
          handlers.set(name, listeners)
        }
        listeners.add(handler)
        return () => listeners?.delete(handler)
      }),
    },
  }
  const emit = <Name extends WorkbenchEventName>(name: Name, payload: WorkbenchEvents[Name]) => {
    for (const handler of handlers.get(name) ?? []) handler(payload as never)
  }
  return { bridge, emit }
}

describe('recovery store (TASK-070)', () => {
  it('loads the issue list for the workspace', async () => {
    const { bridge } = createBridge([issue()])
    const store = createRecoveryStore(() => bridge)

    await store.getState().load(WORKSPACE_ID)

    expect(bridge.recovery.list).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID })
    expect(store.getState().issues).toEqual([issue()])
    expect(store.getState().loading).toBe(false)
    expect(store.getState().error).toBeUndefined()
  })

  it('dispatches resume to the agent bridge and reloads', async () => {
    const { bridge } = createBridge([issue()])
    const store = createRecoveryStore(() => bridge)

    const resumed = await store.getState().resumeRun(WORKSPACE_ID, 'run-1')

    expect(resumed).toBe(true)
    expect(bridge.agent.resume).toHaveBeenCalledWith({ runId: 'run-1' })
    expect(store.getState().issues).toEqual([])
  })

  it('dispatches repair to worktree validate and reloads', async () => {
    const { bridge } = createBridge([
      issue({
        id: 'broken_worktree:wt-1',
        kind: 'broken_worktree',
        suggestedAction: 'repair',
        worktreeId: 'wt-1',
      }),
    ])
    const store = createRecoveryStore(() => bridge)

    const repaired = await store.getState().repairWorktree(WORKSPACE_ID, 'wt-1')

    expect(repaired).toBe(true)
    expect(bridge.worktree.validate).toHaveBeenCalledWith({ worktreeId: 'wt-1' })
    expect(store.getState().issues).toEqual([])
  })

  it('dispatches discard with explicit confirmation', async () => {
    const { bridge } = createBridge([
      issue({
        id: 'broken_worktree:wt-2',
        kind: 'broken_worktree',
        suggestedAction: 'repair',
        worktreeId: 'wt-2',
      }),
    ])
    const store = createRecoveryStore(() => bridge)

    const discarded = await store.getState().discardWorktree(WORKSPACE_ID, 'wt-2')

    expect(discarded).toBe(true)
    expect(bridge.worktree.discard).toHaveBeenCalledWith({ worktreeId: 'wt-2', confirm: true })
    expect(store.getState().issues).toEqual([])
  })

  it('surfaces bridge errors without clearing the issue list', async () => {
    const { bridge } = createBridge([issue()])
    bridge.agent.resume = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'VALIDATION_FAILED' as const,
        message: 'Only interrupted Agent runs can be resumed.',
        retryable: true,
      },
    }))
    const store = createRecoveryStore(() => bridge)
    await store.getState().load(WORKSPACE_ID)

    const resumed = await store.getState().resumeRun(WORKSPACE_ID, 'run-1')

    expect(resumed).toBe(false)
    expect(store.getState().issues).toEqual([issue()])
    expect(store.getState().error?.message).toContain('interrupted')
  })

  it('reloads when relevant workbench events fire and stops after unsubscribe', async () => {
    const { bridge, emit } = createBridge([])
    const store = createRecoveryStore(() => bridge)
    const stop = store.getState().startSynchronization(WORKSPACE_ID)
    await vi.waitFor(() => expect(bridge.recovery.list).toHaveBeenCalledTimes(1))

    emit('agent.interrupted', { runId: 'run-1', reason: 'process_dead' })
    emit('worktree.merge_conflict', {
      worktreeId: 'wt-1',
      workspaceId: WORKSPACE_ID,
      branch: 'agent/run-1',
      baseBranch: 'main',
      conflicts: ['src/app.ts'],
    })
    await vi.waitFor(() => expect(bridge.recovery.list).toHaveBeenCalledTimes(3))

    stop()
    emit('git.changed', { workspaceId: WORKSPACE_ID })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bridge.recovery.list).toHaveBeenCalledTimes(3)
  })
})
