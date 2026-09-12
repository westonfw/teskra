import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentDefinition,
  IpcResult,
  Worktree,
  WorktreeCreateRequest,
  WorkflowRunDetail,
} from '@teskra/contracts'

import { FAKE_AGENT } from '../agents/definitions/fake'
import { migrateDatabase } from '../db/migrations'
import {
  createCriteriaRepository,
  createReviewRepository,
  createTaskRepository,
  createWorkflowRunRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import type { WorkbenchEvents } from '@teskra/contracts'
import { createTaskManager } from '../tasks/task-manager'
import { createCriteriaGateStepExecutor } from './criteria-gate-step-executor'
import {
  DEFAULT_FULL_WORKFLOW_ID,
  FULL_WORKFLOW_NODE_IDS,
  buildDefaultFullWorkflowDefinition,
} from './default-workflow'
import {
  createFullWorkflowService,
  parseDiffPatch,
  type FullWorkflowService,
} from './full-workflow-service'
import { createIterationController } from './iteration-controller'
import type { StepCompletion, WorkflowStepExecution } from './workflow-engine'
import { createWorkflowEngine } from './workflow-engine'
import { createWorkflowRunStore } from './workflow-run-store'

/**
 * TASK-063 acceptance: the default Full Workflow — one click creates the
 * worktree, runs Implement → Test → Review → Criteria Gate, loops Fix → Test
 * → Review on FAIL through the IterationController (caps stop an
 * always-failing reviewer), and finishes with a Diff + Criteria Result
 * summary. Real in-memory SQLite + real store/engine/gate executor; only the
 * agent / shell / review-panel executors and the worktree/git seams are fakes.
 */

const AT = '2026-09-10T00:00:00.000Z'

const databases: Database.Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

const DIFF_PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
  '',
].join('\n')

interface AgentCall {
  readonly nodeId: string
  readonly iteration: number
  readonly agentRunId: string | undefined
}

interface Fixture {
  readonly service: FullWorkflowService
  readonly events: EventBus<WorkbenchEvents>
  readonly tasks: ReturnType<typeof createTaskRepository>
  readonly reviews: ReturnType<typeof createReviewRepository>
  readonly store: ReturnType<typeof createWorkflowRunStore>
  readonly agentCalls: AgentCall[]
  readonly shellCalls: string[]
  readonly stepContexts: { workspaceId: string; worktreeId?: string }[]
  readonly worktreeCreates: WorktreeCreateRequest[]
  readonly worktreeDiscards: number
  readonly releaseWorktreeCreation: () => void
  readonly reviewBehavior: { decide: (round: number) => StepCompletion }
}

function setup(options?: {
  confirmedCriteria?: boolean
  review?: (round: number) => StepCompletion
  reviewers?: boolean
  overrideDefinition?: boolean
  /** Parks every agent step forever, so start() stays inside the loop. */
  hangAgent?: boolean
  /** Parks worktree creation behind a manual gate (dispose race tests). */
  gateWorktreeCreation?: boolean
}): Fixture {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(database)
  if (!migrated.ok) throw new Error(migrated.error.message)
  databases.push(database)

  const workspaces = createWorkspaceRepository(database)
  const tasks = createTaskRepository(database)
  const criteria = createCriteriaRepository(database)
  const reviews = createReviewRepository(database)
  const workflowRuns = createWorkflowRunRepository(database)
  const worktrees = createWorktreeRepository(database)
  const events = createEventBus()

  const workspace = workspaces.create(
    { id: 'ws-1', name: 'FW fixture', runtime: { kind: 'wsl', distro: 'Ubuntu' }, path: '/repo' },
    AT,
  )
  if (!workspace.ok) throw new Error(workspace.error.message)
  const task = tasks.create(
    { id: 'task-1', workspaceId: 'ws-1', title: 'Full workflow this task', status: 'ready' },
    AT,
  )
  if (!task.ok) throw new Error(task.error.message)
  if (options?.confirmedCriteria !== false) {
    const set = criteria.createSet(
      { id: 'set-1', taskId: 'task-1', version: 1, status: 'confirmed' },
      AT,
    )
    if (!set.ok) throw new Error(set.error.message)
    const criterion = criteria.addCriterion(
      { id: 'crit-1', criteriaSetId: 'set-1', ordinal: 1, description: 'Tests pass' },
      AT,
    )
    if (!criterion.ok) throw new Error(criterion.error.message)
    // The gate reads persisted scores: seed a passing score for the criterion.
    database
      .prepare(
        `INSERT INTO agent_runs (id, workspace_id, task_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
         VALUES ('agent-run-seed', 'ws-1', 'task-1', 'codex', 'completed', 'orchestrated', 'runs/agent-run-seed', '${AT}', '${AT}')`,
      )
      .run()
    const score = reviews.recordScore(
      { id: 'score-1', runId: 'agent-run-seed', criterionId: 'crit-1', result: 'pass' },
      AT,
    )
    if (!score.ok) throw new Error(score.error.message)
  }

  const store = createWorkflowRunStore({ workflowRuns, tasks })
  const taskManager = createTaskManager({ tasks, workspaces, events })

  const agentCalls: AgentCall[] = []
  const shellCalls: string[] = []
  const reviewBehavior = {
    decide:
      options?.review ??
      ((): StepCompletion => ({ outcome: 'approve', result: { panelId: 'panel-1' } })),
  }
  const agentExecutor = {
    execute(execution: WorkflowStepExecution): Promise<StepCompletion> {
      agentCalls.push({
        nodeId: execution.node.id,
        iteration: execution.run.currentIteration,
        agentRunId: execution.context.agentRunId,
      })
      if (options?.hangAgent === true) return new Promise<StepCompletion>(() => {})
      return Promise.resolve({
        outcome: 'success',
        result: { agentRunId: execution.context.agentRunId ?? 'unknown' },
      })
    },
  }
  const shellExecutor = {
    execute(execution: WorkflowStepExecution): Promise<StepCompletion> {
      shellCalls.push(execution.node.id)
      return Promise.resolve({ outcome: 'success', result: { exitCode: 0 } })
    },
  }
  const reviewExecutor = {
    execute(execution: WorkflowStepExecution): Promise<StepCompletion> {
      return Promise.resolve(reviewBehavior.decide(execution.run.currentIteration + 1))
    },
  }
  const engine = createWorkflowEngine({
    runs: store,
    events,
    executors: {
      agent: agentExecutor,
      shell: shellExecutor,
      'review-panel': reviewExecutor,
      'criteria-gate': createCriteriaGateStepExecutor({ reviews, criteria }),
    },
  })

  const registryAgents: AgentDefinition[] = [
    { ...FAKE_AGENT, id: 'codex', defaults: { role: 'implementer' } },
    { ...FAKE_AGENT, id: 'claude', defaults: { role: 'reviewer' } },
    ...(options?.overrideDefinition === true
      ? [
          { ...FAKE_AGENT, id: 'fake-impl', defaults: { role: 'implementer' as const } },
          { ...FAKE_AGENT, id: 'fake-rev', defaults: { role: 'reviewer' as const } },
        ]
      : []),
  ]
  const registry = {
    get: (id: string) => registryAgents.find((agent) => agent.id === id),
    list: () =>
      options?.reviewers === false
        ? registryAgents.filter((agent) => agent.defaults.role !== 'reviewer')
        : registryAgents,
  }

  const stepContexts: { workspaceId: string; worktreeId?: string }[] = []
  let agentRunCounter = 0
  const createController = (firstAgentRunId: string) => {
    let firstConsumed = false
    return createIterationController({
      runs: store,
      engine,
      registry,
      tasks,
      taskManager,
      criteria,
      workspaces,
      events,
      createAgentRunId: () => {
        if (!firstConsumed) {
          firstConsumed = true
          return firstAgentRunId
        }
        agentRunCounter += 1
        return `agent-run-next-${String(agentRunCounter)}`
      },
      resolveStepContext: (input) => {
        stepContexts.push(input)
        return { ok: true, data: undefined }
      },
    })
  }

  const worktreeCreates: WorktreeCreateRequest[] = []
  let worktreeCounter = 0
  let worktreeDiscards = 0
  let releaseGate: (() => void) | undefined
  const worktreeManager = {
    create: (request: WorktreeCreateRequest): Promise<IpcResult<Worktree>> => {
      worktreeCreates.push(request)
      const createWorktree = (): IpcResult<Worktree> => {
        worktreeCounter += 1
        const created = worktrees.create(
          {
            id: `wt-${String(worktreeCounter)}`,
            workspaceId: request.workspaceId,
            ...(request.runId === undefined ? {} : { runId: request.runId }),
            branch: `agent/${request.taskId ?? 'none'}/${request.agentId ?? 'none'}/${request.runId ?? 'none'}`,
            baseBranch: 'main',
            path: `/worktrees/${request.runId ?? 'none'}`,
            state: 'ready',
            isolation: request.isolation ?? 'worktree',
          },
          AT,
        )
        if (!created.ok) throw new Error(created.error.message)
        return { ok: true, data: created.data }
      }
      if (options?.gateWorktreeCreation === true) {
        return new Promise((resolve) => {
          releaseGate = () => {
            resolve(createWorktree())
          }
        })
      }
      return Promise.resolve(createWorktree())
    },
    discard: (): Promise<IpcResult<Worktree>> => {
      if (options?.gateWorktreeCreation === true) {
        worktreeDiscards += 1
        const discarded = worktrees.listByWorkspace('ws-1', undefined, true)
        const first = discarded.ok ? discarded.data[0] : undefined
        if (first === undefined) throw new Error('no worktree to discard in this fixture')
        return Promise.resolve({ ok: true, data: first })
      }
      throw new Error('unexpected discard in this fixture')
    },
  }

  const definitions = {
    list: () => {
      if (options?.overrideDefinition !== true) return { ok: true as const, data: [] }
      return {
        ok: true as const,
        data: [
          {
            path: '/repo/.teskra/workflows/full.yaml',
            status: 'loaded' as const,
            id: DEFAULT_FULL_WORKFLOW_ID,
            definition: buildDefaultFullWorkflowDefinition({
              implementer: 'fake-impl',
              reviewers: ['fake-rev'],
              testCommand: 'make test',
            }),
            issues: [],
          },
        ],
      }
    },
  }

  const service = createFullWorkflowService({
    runs: store,
    tasks,
    workspaces,
    criteria,
    reviews,
    worktrees,
    registry,
    worktreeManager,
    definitions,
    git: { diffRefs: () => Promise.resolve({ ok: true, data: { patch: DIFF_PATCH } }) },
    createController,
  })

  return {
    service,
    events,
    tasks,
    reviews,
    store,
    agentCalls,
    shellCalls,
    stepContexts,
    worktreeCreates,
    get worktreeDiscards() {
      return worktreeDiscards
    },
    releaseWorktreeCreation: () => releaseGate?.(),
    reviewBehavior,
  }
}

function getRun(store: Fixture['store'], runId: string): WorkflowRunDetail {
  const detail = store.getRun(runId)
  if (!detail.ok || detail.data === null) throw new Error('run vanished')
  return detail.data
}

describe('FullWorkflowService (TASK-063)', () => {
  it('runs the full default flow to PASS in one round and summarizes diff + criteria', async () => {
    const fixture = setup()
    const runStatuses: string[] = []
    fixture.events.subscribe('workflow.run_updated', ({ status }) => runStatuses.push(status))
    const stepUpdates: string[] = []
    fixture.events.subscribe('workflow.step_updated', ({ nodeId, status }) =>
      stepUpdates.push(`${nodeId}:${status}`),
    )

    const started = await fixture.service.start({ workspaceId: 'ws-1', taskId: 'task-1' })
    if (!started.ok) throw new Error(started.error.message)

    expect(started.data.stopReason).toBe('passed')
    expect(started.data.rounds).toBe(1)
    expect(started.data.run.status).toBe('completed')

    // Worktree created up-front, bound to round 1's pre-allocated AgentRun id.
    expect(fixture.worktreeCreates).toHaveLength(1)
    const createdWorktree = fixture.worktreeCreates[0]
    expect(fixture.agentCalls.map((call) => call.nodeId)).toEqual(['implement'])
    expect(createdWorktree?.runId).toBe(fixture.agentCalls[0]?.agentRunId)
    expect(createdWorktree?.agentId).toBe('codex')

    // Every default-flow stage executed once, in order, plus step events.
    expect(fixture.shellCalls).toEqual([FULL_WORKFLOW_NODE_IDS.testImplement])
    expect(stepUpdates).toContain(`${FULL_WORKFLOW_NODE_IDS.gateImplement}:completed`)
    expect(stepUpdates).toContain(`${FULL_WORKFLOW_NODE_IDS.reviewImplement}:completed`)
    expect(runStatuses).toEqual(expect.arrayContaining(['running', 'completed']))

    // The persisted snapshot is the 8-node default full workflow definition.
    const detail = getRun(fixture.store, started.data.run.id)
    expect(detail.run.workflowDefinitionId).toBe(DEFAULT_FULL_WORKFLOW_ID)
    expect(detail.run.definition.steps).toHaveLength(8)
    expect(detail.run.criteriaSetId).toBe('set-1')
    const gate = detail.steps.find((step) => step.nodeId === FULL_WORKFLOW_NODE_IDS.gateImplement)
    expect(gate?.status).toBe('completed')
    expect(gate?.result?.['outcome']).toBe('pass')

    // Completion view: worktree branch diff + criteria result.
    const summary = await fixture.service.summary({ runId: started.data.run.id })
    if (!summary.ok) throw new Error(summary.error.message)
    expect(summary.data.worktree?.branch).toBe(started.data.worktree.branch)
    expect(summary.data.diff?.files).toEqual([
      expect.objectContaining({ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 }),
      expect.objectContaining({ path: 'src/new.ts', status: 'added', additions: 2, deletions: 0 }),
    ])
    expect(summary.data.criteriaOutcome).toBe('pass')
    expect(summary.data.criteria.map((criterion) => criterion.id)).toEqual(['crit-1'])
    expect(summary.data.criterionScores.map((score) => score.result)).toEqual(['pass'])
  })

  it('loops Fix → Test → Review through the IterationController and stops at the safety cap', async () => {
    const fixture = setup({
      review: () => ({ outcome: 'changes_requested', result: { panelId: 'panel-x' } }),
    })
    const started = await fixture.service.start({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      policy: { maxRoundsPerCriteriaVersion: 3, maxTotalRounds: 8 },
    })
    if (!started.ok) throw new Error(started.error.message)

    // 失败不会自动无限循环：3 轮后双上限之一触发（plan §124 两实体两状态）。
    expect(started.data.stopReason).toBe('max_rounds_per_criteria_version')
    expect(started.data.rounds).toBe(3)
    expect(started.data.run.status).toBe('needs_user_review')
    expect(fixture.agentCalls.map((call) => call.nodeId)).toEqual(['implement', 'fix', 'fix'])
    expect(fixture.shellCalls).toEqual(['test-implement', 'test-fix', 'test-fix'])
    const task = fixture.tasks.getById('task-1')
    expect(task.ok && task.data?.status).toBe('needs_review')

    // The gates never ran: their conditional edge needs a review 'approve'.
    const detail = getRun(fixture.store, started.data.run.id)
    const gates = detail.steps.filter((step) => step.nodeType === 'criteria-gate')
    expect(gates.every((step) => step.status === 'skipped')).toBe(true)
  })

  it('requires a confirmed acceptance criteria set before launch', async () => {
    const fixture = setup({ confirmedCriteria: false })
    const started = await fixture.service.start({ workspaceId: 'ws-1', taskId: 'task-1' })
    expect(started.ok).toBe(false)
    if (!started.ok) expect(started.error.message).toContain('criteria')
    expect(fixture.worktreeCreates).toHaveLength(0)
  })

  it('fails clearly when the registry has no reviewer agent (never hardcoded)', async () => {
    const fixture = setup({ reviewers: false })
    const started = await fixture.service.start({ workspaceId: 'ws-1', taskId: 'task-1' })
    expect(started.ok).toBe(false)
    if (!started.ok) expect(started.error.message).toContain('reviewer')
    expect(fixture.worktreeCreates).toHaveLength(0)
  })

  it('rejects foreign tasks and unknown runs', async () => {
    const fixture = setup()
    const wrong = await fixture.service.start({ workspaceId: 'ws-other', taskId: 'task-1' })
    expect(wrong.ok).toBe(false)
    const summary = await fixture.service.summary({ runId: 'nope' })
    expect(summary.ok).toBe(false)
  })

  it('honors a repo-local full.yaml override for agent ids and the test command', async () => {
    const fixture = setup({ overrideDefinition: true })
    const started = await fixture.service.start({ workspaceId: 'ws-1', taskId: 'task-1' })
    if (!started.ok) throw new Error(started.error.message)
    expect(started.data.stopReason).toBe('passed')
    expect(fixture.worktreeCreates[0]?.agentId).toBe('fake-impl')
    const detail = getRun(fixture.store, started.data.run.id)
    const testNode = detail.run.definition.steps.find(
      (node) => node.id === FULL_WORKFLOW_NODE_IDS.testImplement,
    )
    expect(testNode?.type === 'shell' && testNode.command).toBe('make test')
    const reviewNode = detail.run.definition.steps.find(
      (node) => node.id === FULL_WORKFLOW_NODE_IDS.reviewImplement,
    )
    expect(reviewNode?.type === 'review-panel' && reviewNode.agents).toEqual(['fake-rev'])
  })

  it('resolves the worktree-bound step context for shell steps', async () => {
    const fixture = setup()
    const started = await fixture.service.start({ workspaceId: 'ws-1', taskId: 'task-1' })
    if (!started.ok) throw new Error(started.error.message)
    expect(fixture.stepContexts).toEqual([
      { workspaceId: 'ws-1', worktreeId: started.data.worktree.id },
    ])
  })

  it('dispose cancels the in-flight start and waits for it to settle (P2-1)', async () => {
    const fixture = setup({ hangAgent: true })

    const pending = fixture.service.start({ workspaceId: 'ws-1', taskId: 'task-1' })
    // Round 1's implement step is parked inside the controller's engine pass.
    await vi.waitFor(() => {
      expect(fixture.agentCalls).toHaveLength(1)
    })

    await fixture.service.dispose()

    const started = await pending
    if (!started.ok) throw new Error(started.error.message)
    expect(started.data.stopReason).toBe('cancelled')
    expect(started.data.run.status).toBe('cancelled')

    // Idempotent: nothing is in flight anymore.
    await fixture.service.dispose()
  })

  it('aborts a start still in preparation when dispose() runs, without creating a run', async () => {
    const fixture = setup({ gateWorktreeCreation: true })

    const pending = fixture.service.start({ workspaceId: 'ws-1', taskId: 'task-1' })
    await vi.waitFor(() => {
      expect(fixture.worktreeCreates).toHaveLength(1)
    })

    // The start is parked in worktree creation — no controller exists yet, so
    // dispose() cannot reach it through activeControllers. It must abort via
    // the disposing flag instead of starting a loop underneath dispose.
    const disposed = fixture.service.dispose()
    fixture.releaseWorktreeCreation()
    await disposed

    const started = await pending
    expect(started.ok).toBe(false)
    if (!started.ok) expect(started.error.message).toContain('shutting down')
    expect(fixture.store.listRuns()).toMatchObject({ ok: true, data: [] })
    expect(fixture.agentCalls).toHaveLength(0)
    expect(fixture.worktreeDiscards).toBe(1)
  })
})

describe('parseDiffPatch (TASK-063)', () => {
  it('splits a multi-file unified diff into per-file records', () => {
    const result = parseDiffPatch(DIFF_PATCH)
    expect(result.files).toHaveLength(2)
    expect(result.files[0]).toMatchObject({ path: 'src/a.ts', status: 'modified' })
    expect(result.files[1]).toMatchObject({ path: 'src/new.ts', status: 'added' })
    expect(result.files[1]?.patch).toContain('new file mode')
    expect(parseDiffPatch('').files).toEqual([])
  })
})
