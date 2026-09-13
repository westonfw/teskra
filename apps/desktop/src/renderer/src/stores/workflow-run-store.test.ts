import type {
  FullWorkflowRunSummary,
  FullWorkflowStartResult,
  PublicAppError,
  WorkflowRun,
  WorkflowRunDetail,
  WorkbenchEvents,
} from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createWorkflowRunStore, type WorkflowRunStoreBridge } from './workflow-run-store'

const AT = '2026-09-10T00:00:00.000Z'

function makeRun(overrides: Partial<WorkflowRun> & Pick<WorkflowRun, 'id'>): WorkflowRun {
  return {
    taskId: 'task-1',
    workflowDefinitionId: 'full',
    definition: {
      id: 'full',
      steps: [{ id: 'implement', type: 'agent', agent: 'codex', runOn: 'first' }],
    },
    status: 'running',
    currentIteration: 0,
    totalIterations: 8,
    criteriaIteration: 0,
    createdAt: AT,
    ...overrides,
  }
}

function makeDetail(run: WorkflowRun): WorkflowRunDetail {
  return {
    run,
    steps: [
      {
        id: `step-${run.id}`,
        workflowRunId: run.id,
        nodeId: 'implement',
        nodeType: 'agent',
        status: 'running',
        iteration: run.currentIteration,
        attempt: 1,
        createdAt: AT,
      },
    ],
  }
}

function makeSummary(run: WorkflowRun): FullWorkflowRunSummary {
  return {
    run,
    steps: [],
    worktree: null,
    diff: {
      files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: 'x' }],
    },
    criteria: [],
    criterionScores: [],
    criteriaOutcome: 'pass',
  }
}

function setup(initialRuns: WorkflowRun[] = []) {
  const runs = new Map(initialRuns.map((run) => [run.id, run]))
  const summaries = new Map<string, FullWorkflowRunSummary>()
  const handlers = new Map<string, Set<(payload: { runId: string }) => void>>()
  const bridge: WorkflowRunStoreBridge = {
    workflow: {
      listRuns: vi.fn(async () => ({ ok: true as const, data: [...runs.values()] })),
      getRun: vi.fn(async (request: { runId: string }) => {
        const run = runs.get(request.runId)
        return { ok: true as const, data: run === undefined ? null : makeDetail(run) }
      }),
      startFullWorkflow: vi.fn(async () => {
        const run = makeRun({ id: 'wf-new', status: 'completed' })
        runs.set(run.id, run)
        const worktree = {
          id: 'wt-1',
          workspaceId: 'ws-1',
          branch: 'agent/task-1/codex/run-1',
          baseBranch: 'main',
          path: '/wt',
          state: 'ready' as const,
          isolation: 'worktree' as const,
          createdAt: AT,
          updatedAt: AT,
        }
        const result: FullWorkflowStartResult = { run, worktree, rounds: 1, stopReason: 'passed' }
        return { ok: true as const, data: result }
      }),
      cancelRun: vi.fn(async (request: { runId: string }) => {
        const run = runs.get(request.runId)
        if (run === undefined) {
          return {
            ok: false as const,
            error: { code: 'VALIDATION_FAILED' as const, message: 'not found', retryable: false },
          }
        }
        const cancelled = { ...run, status: 'cancelled' as const }
        runs.set(run.id, cancelled)
        return { ok: true as const, data: cancelled }
      }),
      completeRun: vi.fn(async (request: { runId: string }) => {
        const run = runs.get(request.runId)
        if (run === undefined || run.status !== 'needs_user_review') {
          return {
            ok: false as const,
            error: { code: 'VALIDATION_FAILED' as const, message: 'not parked', retryable: false },
          }
        }
        const completed = { ...run, status: 'completed' as const }
        runs.set(run.id, completed)
        return { ok: true as const, data: completed }
      }),
      runSummary: vi.fn(async (request: { runId: string }) => {
        const run = runs.get(request.runId)
        if (run === undefined) {
          return {
            ok: false as const,
            error: { code: 'VALIDATION_FAILED' as const, message: 'not found', retryable: false },
          }
        }
        const summary = summaries.get(request.runId) ?? makeSummary(run)
        return { ok: true as const, data: summary }
      }),
    },
    events: {
      subscribe: (name, handler) => {
        const registered = handlers.get(name) ?? new Set()
        registered.add(handler as (payload: { runId: string }) => void)
        handlers.set(name, registered)
        return () => registered.delete(handler as (payload: { runId: string }) => void)
      },
    },
  }
  const emit = (
    name: 'workflow.run_updated' | 'workflow.step_updated',
    payload: WorkbenchEvents['workflow.run_updated'] | WorkbenchEvents['workflow.step_updated'],
  ) => {
    for (const handler of handlers.get(name) ?? []) handler(payload)
  }
  return { bridge, runs, summaries, emit, store: createWorkflowRunStore(() => bridge) }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createWorkflowRunStore (TASK-063)', () => {
  it('synchronizes the runs of a task', async () => {
    const { store } = setup([makeRun({ id: 'wf-1' }), makeRun({ id: 'wf-2' })])
    const stop = store.getState().startSynchronization('task-1')
    await flush()
    expect(store.getState().runs.map((run) => run.id)).toEqual(['wf-1', 'wf-2'])
    expect(store.getState().loading).toBe(false)
    stop()
  })

  it('selecting a run loads its step detail', async () => {
    const { store } = setup([makeRun({ id: 'wf-1' })])
    const stop = store.getState().startSynchronization('task-1')
    await flush()
    await store.getState().selectRun('wf-1')
    expect(store.getState().detail?.run.id).toBe('wf-1')
    expect(store.getState().detail?.steps[0]?.nodeId).toBe('implement')
    // A running run has no completion summary yet.
    expect(store.getState().summary).toBeUndefined()
    stop()
  })

  it('refreshes the selected run on workflow.step_updated / run_updated events', async () => {
    const { bridge, runs, emit, store } = setup([makeRun({ id: 'wf-1' })])
    const stop = store.getState().startSynchronization('task-1')
    await flush()
    await store.getState().selectRun('wf-1')
    expect(bridge.workflow.getRun).toHaveBeenCalledTimes(1)

    runs.set('wf-1', makeRun({ id: 'wf-1', currentIteration: 1 }))
    emit('workflow.step_updated', {
      runId: 'wf-1',
      stepId: 'step-wf-1',
      nodeId: 'implement',
      status: 'completed',
    })
    await flush()
    expect(bridge.workflow.getRun).toHaveBeenCalledTimes(2)
    expect(store.getState().detail?.run.currentIteration).toBe(1)
    stop()
  })

  it('loads the completion summary (diff + criteria result) once the run settles', async () => {
    const { store } = setup([makeRun({ id: 'wf-1', status: 'completed' })])
    const stop = store.getState().startSynchronization('task-1')
    await flush()
    await store.getState().selectRun('wf-1')
    expect(store.getState().summary?.criteriaOutcome).toBe('pass')
    expect(store.getState().summary?.diff?.files[0]?.path).toBe('src/a.ts')
    stop()
  })

  it('refreshes the summary when a capped run resumes (needs_user_review visible)', async () => {
    const { bridge, runs, emit, store } = setup([
      makeRun({ id: 'wf-1', status: 'needs_user_review' }),
    ])
    const stop = store.getState().startSynchronization('task-1')
    await flush()
    await store.getState().selectRun('wf-1')
    expect(bridge.workflow.runSummary).toHaveBeenCalledTimes(1)

    runs.set('wf-1', makeRun({ id: 'wf-1', status: 'running', currentIteration: 3 }))
    emit('workflow.run_updated', { runId: 'wf-1', status: 'running' })
    await flush()
    expect(bridge.workflow.listRuns).toHaveBeenCalledTimes(2)
    expect(store.getState().runs[0]?.status).toBe('running')
    stop()
  })

  it('one-click start launches the full workflow and selects the new run', async () => {
    const { bridge, store } = setup([])
    const stop = store.getState().startSynchronization('task-1')
    await flush()
    const started = await store
      .getState()
      .startFullWorkflow({ workspaceId: 'ws-1', taskId: 'task-1' })
    expect(started?.run.id).toBe('wf-new')
    expect(bridge.workflow.startFullWorkflow).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      taskId: 'task-1',
    })
    expect(store.getState().starting).toBe(false)
    expect(store.getState().selectedId).toBe('wf-new')
    expect(store.getState().runs.map((run) => run.id)).toContain('wf-new')
    stop()
  })

  it('surfaces launch failures and transport errors instead of throwing', async () => {
    const failure: PublicAppError = {
      code: 'VALIDATION_FAILED',
      message: 'no criteria',
      retryable: false,
    }
    const { bridge, store } = setup([])
    bridge.workflow.startFullWorkflow = vi.fn(async () => ({ ok: false as const, error: failure }))
    const started = await store
      .getState()
      .startFullWorkflow({ workspaceId: 'ws-1', taskId: 'task-1' })
    expect(started).toBeUndefined()
    expect(store.getState().error?.message).toBe('no criteria')
    expect(store.getState().starting).toBe(false)
    store.getState().clearError()
    expect(store.getState().error).toBeUndefined()

    bridge.workflow.listRuns = vi.fn(async () => {
      throw new Error('ipc down')
    })
    await store.getState().synchronize('task-1')
    expect(store.getState().error?.code).toBe('UNKNOWN')
  })

  it('cancels an in-flight run and refreshes the list', async () => {
    const { bridge, store } = setup([makeRun({ id: 'wf-1', status: 'running' })])
    const stop = store.getState().startSynchronization('task-1')
    await vi.waitFor(() => {
      expect(store.getState().runs).toHaveLength(1)
    })

    const cancelled = await store.getState().cancelRun('wf-1')

    expect(cancelled).toBe(true)
    expect(bridge.workflow.cancelRun).toHaveBeenCalledWith({ runId: 'wf-1' })
    expect(store.getState().runs.find((run) => run.id === 'wf-1')?.status).toBe('cancelled')
    stop()
  })

  it('accepts a capped run and closes it as completed', async () => {
    const { bridge, store } = setup([makeRun({ id: 'wf-1', status: 'needs_user_review' })])
    const stop = store.getState().startSynchronization('task-1')
    await vi.waitFor(() => {
      expect(store.getState().runs).toHaveLength(1)
    })

    const completed = await store.getState().completeRun('wf-1')

    expect(completed).toBe(true)
    expect(bridge.workflow.completeRun).toHaveBeenCalledWith({ runId: 'wf-1' })
    expect(store.getState().runs.find((run) => run.id === 'wf-1')?.status).toBe('completed')
    stop()
  })
})
