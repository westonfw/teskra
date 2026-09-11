import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { StepCompletion, WorkflowStepExecution } from './workflow-engine'
import type {
  AgentDefinition,
  IpcResult,
  WorkflowIterateResult,
  WorkflowRunDetail,
  WorkbenchEvents,
} from '@teskra/contracts'

import { FAKE_AGENT } from '../agents/definitions/fake'
import { migrateDatabase } from '../db/migrations'
import {
  createCriteriaRepository,
  createTaskRepository,
  createWorkflowRunRepository,
  createWorkspaceRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createTaskManager } from '../tasks/task-manager'
import { createWorkflowEngine } from './workflow-engine'
import { createWorkflowRunStore } from './workflow-run-store'
import { createIterationController, type IterationController } from './iteration-controller'

/**
 * TASK-062 acceptance: the Iterate Primitive (Implement → Review → Fix →
 * Review) with the plan §124 Safety Cap — maxRoundsPerCriteriaVersion
 * (default 3) resets when the confirmed criteria version changes,
 * maxTotalRounds (default 8) never does; on cap WorkflowRun =
 * needs_user_review AND Task = needs_review; counters are persisted
 * (a fresh controller instance over the same DB judges identically); every
 * round keeps its own agent run / step rows.
 *
 * Real in-memory SQLite + real WorkflowRunStore + real WorkflowEngine; only
 * the step executors are fakes (the "always failing reviewer" is a
 * review-panel executor that always settles 'changes_requested').
 */

const AT = '2026-09-10T00:00:00.000Z'

const databases: Database.Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

interface AgentCall {
  readonly nodeId: string
  readonly iteration: number
  readonly agentRunId: string
}

interface Fixture {
  readonly controller: IterationController
  readonly events: EventBus<WorkbenchEvents>
  readonly criteria: ReturnType<typeof createCriteriaRepository>
  readonly tasks: ReturnType<typeof createTaskRepository>
  readonly store: ReturnType<typeof createWorkflowRunStore>
  readonly agentCalls: AgentCall[]
  readonly reviewRounds: number[]
  /** Controls the fake reviewer's verdict per call (1-based round order). */
  readonly reviewBehavior: { decide: (round: number) => StepCompletion }
  /** Builds a second controller over the SAME database (restart simulation). */
  readonly restart: () => IterationController
}

function setup(options?: { review?: (round: number) => StepCompletion }): Fixture {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(database)
  if (!migrated.ok) throw new Error(migrated.error.message)
  databases.push(database)

  const workspaces = createWorkspaceRepository(database)
  const tasks = createTaskRepository(database)
  const criteria = createCriteriaRepository(database)
  const workflowRuns = createWorkflowRunRepository(database)
  const events = createEventBus()

  const workspace = workspaces.create(
    {
      id: 'workspace-1',
      name: 'Iterate fixture',
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      path: '/repo',
    },
    AT,
  )
  if (!workspace.ok) throw new Error(workspace.error.message)
  const task = tasks.create(
    { id: 'task-1', workspaceId: 'workspace-1', title: 'Iterate this task', status: 'ready' },
    AT,
  )
  if (!task.ok) throw new Error(task.error.message)
  const set = criteria.createSet(
    { id: 'set-1', taskId: 'task-1', version: 1, status: 'confirmed' },
    AT,
  )
  if (!set.ok) throw new Error(set.error.message)

  const store = createWorkflowRunStore({ workflowRuns, tasks })
  const taskManager = createTaskManager({ tasks, workspaces, events })

  const agentCalls: AgentCall[] = []
  const reviewRounds: number[] = []
  const reviewBehavior = {
    decide:
      options?.review ??
      ((): StepCompletion => ({ outcome: 'changes_requested', result: { panelId: 'panel' } })),
  }

  const agentExecutor = {
    execute(execution: WorkflowStepExecution): Promise<StepCompletion> {
      const agentRunId = `agent-run-${String(agentCalls.length + 1)}`
      agentCalls.push({
        nodeId: execution.node.id,
        iteration: execution.run.currentIteration,
        agentRunId,
      })
      return Promise.resolve({ outcome: 'success', result: { agentRunId } })
    },
  }
  const reviewExecutor = {
    execute(execution: WorkflowStepExecution): Promise<StepCompletion> {
      reviewRounds.push(execution.run.currentIteration + 1)
      return Promise.resolve(reviewBehavior.decide(execution.run.currentIteration + 1))
    },
  }

  const registry = {
    get: (id: string): AgentDefinition | undefined =>
      ['codex', 'claude'].includes(id) ? { ...FAKE_AGENT, id } : undefined,
  }

  const makeController = (): IterationController => {
    // A fresh engine per controller: the engine holds pass state in memory,
    // so a "restart" must rebuild it too; the store is DB-backed either way.
    const engine = createWorkflowEngine({
      runs: store,
      events,
      executors: { agent: agentExecutor, 'review-panel': reviewExecutor },
    })
    return createIterationController({
      runs: store,
      engine,
      registry,
      tasks,
      taskManager,
      criteria,
      workspaces,
      events,
    })
  }

  return {
    controller: makeController(),
    events,
    criteria,
    tasks,
    store,
    agentCalls,
    reviewRounds,
    reviewBehavior,
    restart: makeController,
  }
}

function getRun(store: Fixture['store'], runId: string): WorkflowRunDetail {
  const detail = store.getRun(runId)
  if (!detail.ok || detail.data === null) throw new Error('run vanished')
  return detail.data
}

function expectOk(result: IpcResult<WorkflowIterateResult>): WorkflowIterateResult {
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

describe('IterationController (TASK-062)', () => {
  it('stops at maxRoundsPerCriteriaVersion (default 3) with an always-failing reviewer', async () => {
    const fixture = setup()
    const runEvents: string[] = []
    fixture.events.subscribe('workflow.run_updated', ({ status }) => runEvents.push(status))
    const taskEvents: string[] = []
    fixture.events.subscribe('task.updated', ({ taskId }) => taskEvents.push(taskId))

    const result = expectOk(
      await fixture.controller.iterate({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        agent: 'codex',
        reviewers: ['claude'],
      }),
    )

    expect(result.stopReason).toBe('max_rounds_per_criteria_version')
    expect(result.rounds).toBe(3)
    expect(result.run.status).toBe('needs_user_review')
    expect(fixture.reviewRounds).toEqual([1, 2, 3])

    // 上限触发：两个实体两个状态（plan §124）。
    const task = fixture.tasks.getById('task-1')
    expect(task.ok && task.data?.status).toBe('needs_review')

    // 计数持久化在 workflow_runs（current_iteration / criteria_iteration）。
    const detail = getRun(fixture.store, result.run.id)
    expect(detail.run.currentIteration).toBe(3)
    expect(detail.run.criteriaIteration).toBe(3)
    expect(detail.run.totalIterations).toBe(8)
    expect(detail.run.criteriaSetId).toBe('set-1')

    // 每一轮保留独立 Run：3 个不同的 agent run id（implement → fix → fix）。
    expect(fixture.agentCalls.map((call) => call.nodeId)).toEqual(['implement', 'fix', 'fix'])
    expect(new Set(fixture.agentCalls.map((call) => call.agentRunId)).size).toBe(3)
    const agentSteps = detail.steps.filter((step) => step.nodeType === 'agent')
    const agentStepRows = agentSteps
      .map((step) => [step.nodeId, step.iteration, step.status] as const)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    expect(agentStepRows).toEqual([
      ['fix', 0, 'skipped'],
      ['implement', 0, 'completed'],
      ['fix', 1, 'completed'],
      ['implement', 1, 'skipped'],
      ['fix', 2, 'completed'],
      ['implement', 2, 'skipped'],
    ])
    const executedAgentRunIds = agentSteps
      .filter((step) => step.status === 'completed')
      .map((step) => step.result?.['agentRunId'])
    expect(new Set(executedAgentRunIds).size).toBe(3)
    const reviewSteps = detail.steps.filter(
      (step) => step.nodeType === 'review-panel' && step.status === 'completed',
    )
    expect(reviewSteps.map((step) => [step.nodeId, step.iteration])).toEqual([
      ['review-implement', 0],
      ['review-fix', 1],
      ['review-fix', 2],
    ])

    expect(runEvents).toContain('needs_user_review')
    expect(taskEvents).toContain('task-1')
  })

  it('completes the run when a later round passes review', async () => {
    const fixture = setup({
      review: (round) =>
        round < 2
          ? { outcome: 'changes_requested', result: { panelId: 'panel' } }
          : { outcome: 'approve', result: { panelId: 'panel', consensus: 'approve' } },
    })

    const result = expectOk(
      await fixture.controller.iterate({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        agent: 'codex',
        reviewers: ['claude'],
      }),
    )

    expect(result.stopReason).toBe('passed')
    expect(result.rounds).toBe(2)
    expect(result.run.status).toBe('completed')
    expect(fixture.agentCalls.map((call) => call.nodeId)).toEqual(['implement', 'fix'])
    // 成功路径不碰 Task 状态（needs_review 专属于超限/人工标记）。
    const task = fixture.tasks.getById('task-1')
    expect(task.ok && task.data?.status).toBe('ready')
  })

  it('maxTotalRounds accumulates across criteria versions (never resets)', async () => {
    const policy = { maxRoundsPerCriteriaVersion: 3, maxTotalRounds: 4 }
    const fixture = setup()

    const first = expectOk(
      await fixture.controller.iterate({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        agent: 'codex',
        reviewers: ['claude'],
        policy,
      }),
    )
    expect(first.stopReason).toBe('max_rounds_per_criteria_version')
    expect(first.rounds).toBe(3)

    // 用户改了 Criteria：确认一个 v2 集合（v1 被 supersede）。
    const superseded = fixture.criteria.supersedeSet('set-1')
    if (!superseded.ok) throw new Error(superseded.error.message)
    const v2 = fixture.criteria.createSet(
      { id: 'set-2', taskId: 'task-1', version: 2, status: 'confirmed' },
      AT,
    )
    if (!v2.ok) throw new Error(v2.error.message)

    // 模拟 App 重启：同一 DB 上的全新 controller + engine 实例。
    const restarted = fixture.restart()
    const second = expectOk(
      await restarted.iterate({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        runId: first.run.id,
        policy,
      }),
    )

    // 版本计数清零（v2 下只跑了 1 轮），总计数不清零（4 轮触发上限）。
    expect(second.stopReason).toBe('max_total_rounds')
    expect(second.rounds).toBe(4)
    const detail = getRun(fixture.store, first.run.id)
    expect(detail.run.criteriaSetId).toBe('set-2')
    expect(detail.run.criteriaIteration).toBe(1)
    expect(detail.run.currentIteration).toBe(4)
    expect(detail.run.status).toBe('needs_user_review')
    expect(fixture.reviewRounds).toEqual([1, 2, 3, 4])
  })

  it('re-triggers the cap immediately on resume without a criteria change (restart-safe)', async () => {
    const policy = { maxRoundsPerCriteriaVersion: 2, maxTotalRounds: 8 }
    const fixture = setup()

    const first = expectOk(
      await fixture.controller.iterate({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        agent: 'codex',
        reviewers: ['claude'],
        policy,
      }),
    )
    expect(first.stopReason).toBe('max_rounds_per_criteria_version')
    expect(first.rounds).toBe(2)
    const agentCallsBefore = fixture.agentCalls.length

    // 重启后 Criteria 未变：不消耗新一轮，直接再次触发上限。
    const restarted = fixture.restart()
    const second = expectOk(
      await restarted.iterate({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        runId: first.run.id,
        policy,
      }),
    )
    expect(second.stopReason).toBe('max_rounds_per_criteria_version')
    expect(second.rounds).toBe(2)
    expect(fixture.agentCalls.length).toBe(agentCallsBefore)
    expect(getRun(fixture.store, first.run.id).run.status).toBe('needs_user_review')
  })

  it('rejects unknown agents and foreign run ids', async () => {
    const fixture = setup()

    const unknownAgent = await fixture.controller.iterate({
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      agent: 'not-an-agent',
      reviewers: ['claude'],
    })
    expect(unknownAgent.ok).toBe(false)

    const started = expectOk(
      await fixture.controller.iterate({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        agent: 'codex',
        reviewers: ['claude'],
        policy: { maxRoundsPerCriteriaVersion: 1 },
      }),
    )
    const otherTask = fixture.tasks.create(
      { id: 'task-2', workspaceId: 'workspace-1', title: 'Other task' },
      AT,
    )
    if (!otherTask.ok) throw new Error(otherTask.error.message)
    const foreign = await fixture.controller.iterate({
      workspaceId: 'workspace-1',
      taskId: 'task-2',
      runId: started.run.id,
    })
    expect(foreign.ok).toBe(false)
  })

  /**
   * Regression: a second iterate() for a run whose loop is still in flight
   * hit the engine's duplicate-pass rejection and the controller responded
   * by marking the run 'failed' — while the first loop was still driving it.
   */
  it('rejects a concurrent iterate on the same run without failing the active loop', async () => {
    const database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    const migrated = migrateDatabase(database)
    if (!migrated.ok) throw new Error(migrated.error.message)
    databases.push(database)

    const workspaces = createWorkspaceRepository(database)
    const tasks = createTaskRepository(database)
    const criteria = createCriteriaRepository(database)
    const workflowRuns = createWorkflowRunRepository(database)
    const events = createEventBus()
    const workspace = workspaces.create(
      {
        id: 'workspace-1',
        name: 'Concurrent fixture',
        runtime: { kind: 'wsl', distro: 'Ubuntu' },
        path: '/repo',
      },
      AT,
    )
    if (!workspace.ok) throw new Error(workspace.error.message)
    const task = tasks.create(
      { id: 'task-1', workspaceId: 'workspace-1', title: 'Concurrent iterate', status: 'ready' },
      AT,
    )
    if (!task.ok) throw new Error(task.error.message)

    const store = createWorkflowRunStore({ workflowRuns, tasks })
    const taskManager = createTaskManager({ tasks, workspaces, events })
    // The review executor parks until the test releases it, keeping round 1
    // (and thus the iterate loop) in flight.
    let releaseReview!: () => void
    const reviewExecutor = {
      execute(): Promise<StepCompletion> {
        return new Promise<StepCompletion>((resolve) => {
          releaseReview = () => resolve({ outcome: 'approve', result: { panelId: 'panel' } })
        })
      },
    }
    const agentExecutor = {
      execute(): Promise<StepCompletion> {
        return Promise.resolve({ outcome: 'success', result: { agentRunId: 'agent-run-1' } })
      },
    }
    const registry = {
      get: (id: string): AgentDefinition | undefined =>
        ['codex', 'claude'].includes(id) ? { ...FAKE_AGENT, id } : undefined,
    }
    const engine = createWorkflowEngine({
      runs: store,
      events,
      executors: { agent: agentExecutor, 'review-panel': reviewExecutor },
    })
    const controller = createIterationController({
      runs: store,
      engine,
      registry,
      tasks,
      taskManager,
      criteria,
      workspaces,
      events,
    })

    const first = controller.iterate({
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      agent: 'codex',
      reviewers: ['claude'],
    })
    let runId: string | undefined
    await vi.waitFor(() => {
      const listed = store.listRuns({ status: 'running' })
      expect(listed.ok && listed.data.length).toBe(1)
      runId = listed.ok ? listed.data[0]?.id : undefined
    })
    if (runId === undefined) throw new Error('expected a running workflow run')

    const second = await controller.iterate({
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      runId,
    })
    expect(second.ok).toBe(false)
    // The active loop's run must be untouched.
    expect(getRun(store, runId).run.status).toBe('running')

    releaseReview()
    const result = expectOk(await first)
    expect(result.stopReason).toBe('passed')
  })
})
