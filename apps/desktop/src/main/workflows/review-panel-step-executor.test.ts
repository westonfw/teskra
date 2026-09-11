import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  IpcResult,
  ReviewPanelResult,
  StartReviewPanelRequest,
  WorkbenchEvents,
} from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import { createTaskRepository } from '../db/repositories/task-repository'
import { createWorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { createWorkspaceRepository } from '../db/repositories/workspace-repository'
import { createEventBus } from '../events/event-bus'
import { createReviewPanelStepExecutor } from './review-panel-step-executor'
import { createWorkflowEngine } from './workflow-engine'
import { createWorkflowRunStore } from './workflow-run-store'

/**
 * TASK-060 engine integration: a workflow `review-panel` node executes
 * through ReviewPanelService (instead of suspending for resolveStep) and the
 * panel's consensus maps to the node's outcome.
 */

const databases: Database.Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

function panelResult(status: 'completed' | 'failed', consensus?: 'approve' | 'mixed'): ReviewPanelResult {
  return {
    panel: {
      id: 'panel-1',
      taskId: 'task-1',
      status,
      ...(consensus === undefined ? {} : { consensus }),
      createdAt: '2026-09-10T00:00:00.000Z',
      completedAt: '2026-09-10T00:05:00.000Z',
    },
    members: [],
  }
}

function setup(startPanel: (request: StartReviewPanelRequest) => Promise<IpcResult<ReviewPanelResult>>) {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  databases.push(connection)

  const workspaces = createWorkspaceRepository(connection)
  const tasks = createTaskRepository(connection)
  requireOk(
    workspaces.create({
      id: 'ws-1',
      name: 'Executor fixture',
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      path: '/tmp/repo',
    }),
  )
  requireOk(tasks.create({ id: 'task-1', workspaceId: 'ws-1', title: 'Executor task' }))

  const events = createEventBus<WorkbenchEvents>()
  const store = createWorkflowRunStore({
    workflowRuns: createWorkflowRunRepository(connection),
    tasks,
  })
  const panel = {
    startPanel: vi.fn(startPanel),
    cancelPanel: vi.fn(),
    getPanel: vi.fn(
      (_panelId: string): IpcResult<ReviewPanelResult | null> => ({ ok: true, data: null }),
    ),
  }
  const engine = createWorkflowEngine({
    runs: store,
    events,
    executors: { 'review-panel': createReviewPanelStepExecutor({ panel, events }) },
  })
  return { engine, store, panel, events }
}

const DEFINITION = {
  id: 'panel-workflow',
  steps: [{ id: 'panel', type: 'review-panel', agents: ['claude', 'codex'], runOn: 'always' }],
} as const

describe('createReviewPanelStepExecutor', () => {
  it('drives the panel from the node and maps consensus approve → outcome approve', async () => {
    const { engine, store, panel } = setup(() =>
      Promise.resolve({ ok: true as const, data: panelResult('completed', 'approve') }),
    )
    const run = requireOk(
      store.createRun({ definition: DEFINITION, taskId: 'task-1', totalIterations: 1 }),
    )
    const settled = requireOk(await engine.start(run.run.id, { workspaceId: 'ws-1', worktreeId: 'wt-1' }))

    expect(panel.startPanel).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      reviewers: ['claude', 'codex'],
      workflowRunId: run.run.id,
      targetWorktreeId: 'wt-1',
    })
    const step = settled.steps.find((entry) => entry.nodeId === 'panel')
    expect(step?.status).toBe('completed')
    expect(step?.result).toMatchObject({ outcome: 'approve', panelId: 'panel-1', consensus: 'approve' })
  })

  it('maps a split panel (mixed) to changes_requested, never silently approving', async () => {
    const { engine, store } = setup(() =>
      Promise.resolve({ ok: true as const, data: panelResult('completed', 'mixed') }),
    )
    const run = requireOk(
      store.createRun({ definition: DEFINITION, taskId: 'task-1', totalIterations: 1 }),
    )
    const settled = requireOk(await engine.start(run.run.id, { workspaceId: 'ws-1' }))
    const step = settled.steps.find((entry) => entry.nodeId === 'panel')
    expect(step?.status).toBe('completed')
    expect(step?.result).toMatchObject({ outcome: 'changes_requested', consensus: 'mixed' })
  })

  it('fails the step when the panel does not converge', async () => {
    const { engine, store } = setup(() =>
      Promise.resolve({ ok: true as const, data: panelResult('failed') }),
    )
    const run = requireOk(
      store.createRun({ definition: DEFINITION, taskId: 'task-1', totalIterations: 1 }),
    )
    const settled = requireOk(await engine.start(run.run.id, { workspaceId: 'ws-1' }))
    const step = settled.steps.find((entry) => entry.nodeId === 'panel')
    expect(step?.status).toBe('failed')
    expect(step?.result).toMatchObject({ outcome: 'failure', panelId: 'panel-1' })
  })

  it('fails the step when the workflow run has no task', async () => {
    const { engine, store, panel } = setup(() => {
      throw new Error('startPanel must not be called for a task-less run')
    })
    const run = requireOk(store.createRun({ definition: DEFINITION, totalIterations: 1 }))
    const settled = requireOk(await engine.start(run.run.id, { workspaceId: 'ws-1' }))
    const step = settled.steps.find((entry) => entry.nodeId === 'panel')
    expect(step?.status).toBe('failed')
    expect(panel.startPanel).not.toHaveBeenCalled()
  })

  /**
   * Regression: startPanel settles only after the panel converges, so the
   * executor used to learn the panel id too late — a workflow cancel during
   * the review never reached the panel's reviewer runs. The id is captured
   * from the 'review.panel_updated' creation event instead.
   */
  it('routes a workflow cancel to the in-flight panel', async () => {
    let settlePanel!: (result: IpcResult<ReviewPanelResult>) => void
    const { engine, store, panel, events } = setup(
      () =>
        new Promise<IpcResult<ReviewPanelResult>>((resolve) => {
          settlePanel = resolve
        }),
    )
    const run = requireOk(
      store.createRun({ definition: DEFINITION, taskId: 'task-1', totalIterations: 1 }),
    )
    // The panel row links back to the workflow run; getPanel resolves it.
    panel.getPanel.mockImplementation((panelId: string) => ({
      ok: true as const,
      data: {
        panel: {
          ...panelResult('completed', 'approve').panel,
          id: panelId,
          workflowRunId: run.run.id,
        },
        members: [],
      },
    }))

    const pass = engine.start(run.run.id, { workspaceId: 'ws-1' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(panel.startPanel).toHaveBeenCalled()

    // ReviewPanelService.startPanel emits this synchronously when the panel
    // row is created, long before the reviewers finish.
    events.emit('review.panel_updated', { panelId: 'panel-1', taskId: 'task-1', status: 'running' })

    const cancelled = await engine.cancel(run.run.id)
    expect(cancelled.ok).toBe(true)
    expect(panel.cancelPanel).toHaveBeenCalledWith('panel-1')

    // The cancelled panel converges as failed; the late settlement is ignored.
    settlePanel({ ok: true, data: panelResult('failed') })
    const finished = requireOk(await pass)
    expect(finished.run.status).toBe('cancelled')
  })

  it('cancels the panel when the cancel arrived before the creation event', async () => {
    let settlePanel!: (result: IpcResult<ReviewPanelResult>) => void
    const { engine, store, panel, events } = setup(
      () =>
        new Promise<IpcResult<ReviewPanelResult>>((resolve) => {
          settlePanel = resolve
        }),
    )
    const run = requireOk(
      store.createRun({ definition: DEFINITION, taskId: 'task-1', totalIterations: 1 }),
    )
    panel.getPanel.mockImplementation((panelId: string) => ({
      ok: true as const,
      data: {
        panel: {
          ...panelResult('completed', 'approve').panel,
          id: panelId,
          workflowRunId: run.run.id,
        },
        members: [],
      },
    }))

    const pass = engine.start(run.run.id, { workspaceId: 'ws-1' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Cancel before the panel row exists: the request is recorded and
    // forwarded as soon as the creation event arrives.
    const cancelled = await engine.cancel(run.run.id)
    expect(cancelled.ok).toBe(true)
    expect(panel.cancelPanel).not.toHaveBeenCalled()

    events.emit('review.panel_updated', { panelId: 'panel-1', taskId: 'task-1', status: 'running' })
    expect(panel.cancelPanel).toHaveBeenCalledWith('panel-1')

    settlePanel({ ok: true, data: panelResult('failed') })
    await pass
  })
})
