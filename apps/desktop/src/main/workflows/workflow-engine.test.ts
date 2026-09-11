import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  AgentRun,
  IpcResult,
  StartAgentRunRequest,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
  WorkbenchEvents,
} from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import { createWorkflowRunRepository } from '../db/repositories/workflow-run-repository'
import { createEventBus, type EventBus } from '../events/event-bus'
import {
  createWorkflowEngine,
  type StepCompletion,
  type WorkflowEngine,
  type WorkflowExecutionContext,
  type WorkflowStepExecution,
  type WorkflowStepExecutor,
} from './workflow-engine'
import { createWorkflowRunStore, type WorkflowRunStore } from './workflow-run-store'

/**
 * TASK-057 acceptance: parallel scheduling of dependency-free steps, failure
 * propagation as `skipped` along the DAG, inactive conditional edges →
 * `skipped` (never stuck pending), cancel of queued/running steps, runOn
 * filtering whose out-edges still activate (round-2 `test` is not blocked by
 * `implement`), and guaranteed termination (diamond + all-skip branch).
 */

const CONTEXT: WorkflowExecutionContext = { workspaceId: 'ws-1' }

/** Flushes the microtask queue so executor settlements reach the scheduler. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function define(steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return { id: 'test-workflow', steps }
}

const PARALLEL = define([
  { id: 'a', type: 'agent', agent: 'fake', runOn: 'always' },
  { id: 'b', type: 'agent', agent: 'fake', runOn: 'always' },
])

const SEQUENTIAL = define([
  { id: 'a', type: 'agent', agent: 'fake', runOn: 'always' },
  { id: 'b', type: 'agent', agent: 'fake', dependsOn: ['a'], runOn: 'always' },
])

const FAILURE_CHAIN = define([
  { id: 'a', type: 'agent', agent: 'fake', runOn: 'always' },
  { id: 'b', type: 'agent', agent: 'fake', dependsOn: ['a'], runOn: 'always' },
  { id: 'c', type: 'agent', agent: 'fake', dependsOn: ['b'], runOn: 'always' },
])

const GATE = define([
  { id: 'impl', type: 'agent', agent: 'fake', runOn: 'always' },
  { id: 'gate', type: 'criteria-gate', dependsOn: ['impl'], runOn: 'always' },
  {
    id: 'publish',
    type: 'agent',
    agent: 'fake',
    dependsOn: [{ node: 'gate', on: 'pass' }],
    runOn: 'always',
  },
  {
    id: 'fix',
    type: 'agent',
    agent: 'fake',
    dependsOn: [{ node: 'gate', on: 'fail' }],
    runOn: 'always',
  },
])

const CHECKPOINT = define([
  { id: 'impl', type: 'agent', agent: 'fake', runOn: 'always' },
  { id: 'check', type: 'checkpoint', dependsOn: ['impl'], runOn: 'always' },
])

const RUN_ON = define([
  { id: 'implement', type: 'agent', agent: 'fake', runOn: 'first' },
  { id: 'test', type: 'agent', agent: 'fake', dependsOn: ['implement'], runOn: 'always' },
])

const FUTURE_FILTERED = define([
  { id: 'fix', type: 'agent', agent: 'fake', runOn: 'subsequent' },
  { id: 'test', type: 'agent', agent: 'fake', dependsOn: ['fix'], runOn: 'always' },
])

const DIAMOND_ALL_SKIP = define([
  {
    id: 'root',
    type: 'condition',
    expression: "seed.outcome == 'yes'",
    runOn: 'always',
  },
  { id: 'b', type: 'agent', agent: 'fake', dependsOn: [{ node: 'root', on: 'true' }], runOn: 'always' },
  { id: 'c', type: 'agent', agent: 'fake', dependsOn: [{ node: 'root', on: 'true' }], runOn: 'always' },
  { id: 'd', type: 'agent', agent: 'fake', dependsOn: ['b', 'c'], runOn: 'always' },
])

/** Mock agent executor: execute() parks until the test completes the node. */
function createMockAgentExecutor(): {
  readonly executor: WorkflowStepExecutor
  readonly calls: WorkflowStepExecution[]
  readonly cancelled: string[]
  complete(nodeId: string, completion?: StepCompletion): void
  wasCalled(nodeId: string): boolean
} {
  const calls: WorkflowStepExecution[] = []
  const cancelled: string[] = []
  const pending = new Map<string, (completion: StepCompletion) => void>()
  return {
    calls,
    cancelled,
    executor: {
      execute(execution) {
        calls.push(execution)
        return new Promise<StepCompletion>((resolve) => {
          pending.set(execution.node.id, resolve)
        })
      },
      cancel(stepId) {
        cancelled.push(stepId)
      },
    },
    complete(nodeId, completion = { outcome: 'success' }) {
      const settle = pending.get(nodeId)
      if (settle === undefined) throw new Error(`node "${nodeId}" is not executing`)
      pending.delete(nodeId)
      settle(completion)
    },
    wasCalled(nodeId) {
      return calls.some((call) => call.node.id === nodeId)
    },
  }
}

const openConnections: Database.Database[] = []

afterEach(() => {
  for (const connection of openConnections.splice(0)) {
    connection.close()
  }
})

function setup(definition: WorkflowDefinition): {
  engine: WorkflowEngine
  store: WorkflowRunStore
  events: EventBus<WorkbenchEvents>
  run: WorkflowRun
  agent: ReturnType<typeof createMockAgentExecutor>
  stepEvents: { nodeId: string; status: string }[]
  steps(): WorkflowStep[]
  stepByNode(nodeId: string, iteration?: number): WorkflowStep
} {
  const connection = new Database(':memory:')
  openConnections.push(connection)
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)

  const store = createWorkflowRunStore({
    workflowRuns: createWorkflowRunRepository(connection),
  })
  const events = createEventBus()
  const agent = createMockAgentExecutor()
  const engine = createWorkflowEngine({
    runs: store,
    events,
    executors: { agent: agent.executor },
  })

  const created = store.createRun({ definition })
  if (!created.ok) throw new Error(created.error.message)
  const run = created.data.run

  const stepEvents: { nodeId: string; status: string }[] = []
  events.subscribe('workflow.step_updated', (payload) => {
    stepEvents.push({ nodeId: payload.nodeId, status: payload.status })
  })

  const steps = (): WorkflowStep[] => {
    const detail = store.getRun(run.id)
    if (!detail.ok || detail.data === null) throw new Error('run vanished')
    return detail.data.steps
  }

  return {
    engine,
    store,
    events,
    run,
    agent,
    stepEvents,
    steps,
    stepByNode(nodeId, iteration) {
      const found = steps().find(
        (step) =>
          step.nodeId === nodeId && (iteration === undefined || step.iteration === iteration),
      )
      if (found === undefined) throw new Error(`no step for node "${nodeId}"`)
      return found
    },
  }
}

describe('createWorkflowEngine (TASK-057)', () => {
  it('runs dependency-free steps in parallel', async () => {
    const { engine, run, agent, stepByNode } = setup(PARALLEL)

    const pass = engine.start(run.id, CONTEXT)

    // Both executors started synchronously — neither waits for the other.
    expect(agent.calls.map((call) => call.node.id).sort()).toEqual(['a', 'b'])
    expect(stepByNode('a').status).toBe('running')
    expect(stepByNode('b').status).toBe('running')

    agent.complete('a')
    agent.complete('b')
    const finished = await pass
    expect(finished.ok).toBe(true)
    expect(stepByNode('a').status).toBe('completed')
    expect(stepByNode('b').status).toBe('completed')
    // Pass end parks the run in 'waiting'; the IterationController (TASK-062)
    // owns the run's final fate.
    expect(finished.ok && finished.data.run.status).toBe('waiting')
  })

  it('runs dependent steps only after their upstream completes', async () => {
    const { engine, run, agent, stepByNode } = setup(SEQUENTIAL)

    const pass = engine.start(run.id, CONTEXT)
    expect(agent.wasCalled('a')).toBe(true)
    expect(agent.wasCalled('b')).toBe(false)

    agent.complete('a')
    await flush()
    expect(agent.wasCalled('b')).toBe(true)
    agent.complete('b')
    await pass
    expect(stepByNode('b').status).toBe('completed')
  })

  it('propagates a failure as skipped down the DAG', async () => {
    const { engine, run, agent, stepByNode } = setup(FAILURE_CHAIN)

    const pass = engine.start(run.id, CONTEXT)
    agent.complete('a', { outcome: 'failure', result: { error: 'boom' } })
    const finished = await pass

    expect(finished.ok).toBe(true)
    expect(stepByNode('a').status).toBe('failed')
    expect(stepByNode('a').result).toMatchObject({ outcome: 'failure', error: 'boom' })
    for (const nodeId of ['b', 'c']) {
      expect(stepByNode(nodeId).status).toBe('skipped')
      expect(stepByNode(nodeId).result).toMatchObject({ reason: 'dependency-inactive' })
    }
    expect(agent.wasCalled('b')).toBe(false)
    expect(agent.wasCalled('c')).toBe(false)
  })

  it('sends the downstream of an inactive conditional edge to skipped, not pending', async () => {
    const { engine, run, agent, stepByNode } = setup(GATE)

    const pass = engine.start(run.id, CONTEXT)
    agent.complete('impl')
    // The criteria-gate parks awaiting an external resolution.
    await flush()
    expect(stepByNode('gate').status).toBe('running')

    const resolved = engine.resolveStep(stepByNode('gate').id, { outcome: 'pass' })
    expect(resolved.ok).toBe(true)
    await flush()
    expect(agent.wasCalled('publish')).toBe(true)
    agent.complete('publish')
    const finished = await pass

    expect(finished.ok).toBe(true)
    expect(stepByNode('publish').status).toBe('completed')
    expect(stepByNode('fix').status).toBe('skipped')
    expect(agent.wasCalled('fix')).toBe(false)
  })

  it('rejects a resolveStep outcome the node type does not allow', async () => {
    const { engine, run, agent, stepByNode } = setup(GATE)

    const pass = engine.start(run.id, CONTEXT)
    agent.complete('impl')
    await flush()

    const rejected = engine.resolveStep(stepByNode('gate').id, { outcome: 'maybe' })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.code).toBe('VALIDATION_FAILED')
    // Still suspended: a valid resolution unblocks the pass.
    expect(engine.resolveStep(stepByNode('gate').id, { outcome: 'fail' }).ok).toBe(true)
    await flush()
    agent.complete('fix')
    const finished = await pass
    expect(finished.ok).toBe(true)
    expect(stepByNode('fix').status).toBe('completed')
    expect(stepByNode('publish').status).toBe('skipped')
  })

  it('parks checkpoint steps until resolveStep completes them', async () => {
    const { engine, run, agent, stepByNode } = setup(CHECKPOINT)

    let passSettled = false
    const pass = engine.start(run.id, CONTEXT).then((result) => {
      passSettled = true
      return result
    })
    agent.complete('impl')
    await flush()

    expect(stepByNode('check').status).toBe('running')
    expect(passSettled).toBe(false)

    // A checkpoint has no outcomes; passing one is rejected.
    expect(engine.resolveStep(stepByNode('check').id, { outcome: 'yes' }).ok).toBe(false)
    const resolved = engine.resolveStep(stepByNode('check').id)
    expect(resolved.ok).toBe(true)

    const finished = await pass
    expect(finished.ok).toBe(true)
    expect(stepByNode('check').status).toBe('completed')
  })

  it('cancels queued and running steps and invokes executor cancel hooks', async () => {
    const { engine, run, agent, stepByNode } = setup(SEQUENTIAL)

    const pass = engine.start(run.id, CONTEXT)
    const runningA = stepByNode('a')
    expect(runningA.status).toBe('running')

    const cancelled = await engine.cancel(run.id)
    expect(cancelled.ok).toBe(true)
    if (cancelled.ok) expect(cancelled.data.status).toBe('cancelled')

    // The running step's executor cancel hook fired with its step id.
    expect(agent.cancelled).toEqual([runningA.id])
    expect(stepByNode('a').status).toBe('cancelled')
    // The queued step never started and is cancelled too.
    expect(agent.wasCalled('b')).toBe(false)
    expect(stepByNode('b').status).toBe('cancelled')

    const finished = await pass
    expect(finished.ok && finished.data.run.status).toBe('cancelled')

    // A late executor completion is ignored — the step stays cancelled.
    agent.complete('a')
    await Promise.resolve()
    expect(stepByNode('a').status).toBe('cancelled')
  })

  it('filters runOn nodes per iteration and keeps their out-edges activated', async () => {
    const { engine, store, run, agent, stepByNode, steps } = setup(RUN_ON)

    // Iteration 1: implement runs, then test.
    const first = engine.start(run.id, CONTEXT)
    expect(agent.wasCalled('implement')).toBe(true)
    agent.complete('implement')
    await flush()
    expect(agent.wasCalled('test')).toBe(true)
    agent.complete('test')
    await first
    expect(stepByNode('test', 0).status).toBe('completed')

    const advanced = store.advanceIteration(run.id)
    expect(advanced.ok && advanced.data.currentIteration).toBe(1)

    // Iteration 2: implement is filtered to skipped, but its out-edge still
    // activates — test starts immediately instead of blocking forever.
    const second = engine.start(run.id, CONTEXT)
    const filteredImplement = stepByNode('implement', 1)
    expect(filteredImplement.status).toBe('skipped')
    expect(filteredImplement.result).toMatchObject({
      reason: 'runOn-filtered',
      edgesActivated: true,
    })
    expect(stepByNode('test', 1).status).toBe('running')

    agent.complete('test')
    const finished = await second
    expect(finished.ok).toBe(true)
    expect(steps().filter((step) => step.nodeId === 'implement')).toHaveLength(2)
  })

  it('skips the exclusive downstream of a future-phase runOn node in round 1', async () => {
    const { engine, run, agent, stepByNode } = setup(FUTURE_FILTERED)

    const finished = await engine.start(run.id, CONTEXT)
    expect(finished.ok).toBe(true)
    // fix (runOn: subsequent) is filtered in round 1 and activates nothing,
    // so test — with no other activated in-edge — skips as well (plan §153).
    expect(stepByNode('fix').status).toBe('skipped')
    expect(stepByNode('fix').result).toMatchObject({
      reason: 'runOn-filtered',
      edgesActivated: false,
    })
    expect(stepByNode('test').status).toBe('skipped')
    expect(agent.calls).toHaveLength(0)
  })

  it('terminates on a diamond dependency whose branches all skip', async () => {
    const { engine, run, agent, stepByNode } = setup(DIAMOND_ALL_SKIP)

    // root is a condition node that evaluates to false (no upstream named
    // "seed"), so both conditional branches skip; d must still resolve
    // instead of scheduling forever.
    const finished = await engine.start(run.id, CONTEXT)
    expect(finished.ok).toBe(true)
    expect(stepByNode('root').status).toBe('completed')
    expect(stepByNode('root').result).toMatchObject({ outcome: 'false' })
    for (const nodeId of ['b', 'c', 'd']) {
      expect(stepByNode(nodeId).status).toBe('skipped')
    }
    expect(agent.calls).toHaveLength(0)
  })

  it('emits workflow.step_updated / workflow.run_updated events', async () => {
    const { engine, events, run, agent } = setup(SEQUENTIAL)
    const runEvents: string[] = []
    events.subscribe('workflow.run_updated', (payload) => {
      runEvents.push(payload.status)
    })

    const pass = engine.start(run.id, CONTEXT)
    agent.complete('a')
    await flush()
    agent.complete('b')
    await pass

    expect(runEvents).toEqual(['running', 'waiting'])
  })

  it('refuses to start a second concurrent pass for the same run', async () => {
    const { engine, run } = setup(PARALLEL)

    const first = engine.start(run.id, CONTEXT)
    const second = await engine.start(run.id, CONTEXT)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe('VALIDATION_FAILED')

    await engine.cancel(run.id)
    await first
  })

  it('cancels every active pass on dispose (TASK-059)', async () => {
    const { engine, run, agent, stepByNode } = setup(PARALLEL)

    const pass = engine.start(run.id, CONTEXT)
    expect(stepByNode('a').status).toBe('running')

    engine.dispose()
    const finished = await pass

    expect(finished.ok).toBe(true)
    expect(agent.cancelled).toHaveLength(2)
    expect(stepByNode('a').status).toBe('cancelled')
    expect(stepByNode('b').status).toBe('cancelled')
    expect(finished.ok && finished.data.run.status).toBe('cancelled')
  })
})

describe('agent step executor cancellation', () => {
  function fakeAgentRun(id: string): AgentRun {
    return {
      id,
      workspaceId: 'ws-1',
      agentType: 'fake',
      status: 'running',
      executionMode: 'attended',
      runDir: `runs/${id}`,
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    }
  }

  /**
   * Regression: a cancel arriving while AgentManager.start is still in
   * flight (e.g. agent detection) used to be dropped — the agent run
   * launched anyway and ran to completion after the workflow reported
   * cancelled.
   */
  it('routes a cancel that arrives mid-launch to the run once it materializes', async () => {
    const connection = new Database(':memory:')
    openConnections.push(connection)
    connection.pragma('foreign_keys = ON')
    const migrated = migrateDatabase(connection)
    if (!migrated.ok) throw new Error(migrated.error.message)
    const store = createWorkflowRunStore({
      workflowRuns: createWorkflowRunRepository(connection),
    })
    const events = createEventBus()

    let resolveStart!: (result: IpcResult<AgentRun>) => void
    const startRequests: StartAgentRunRequest[] = []
    const cancelledRunIds: string[] = []
    const agents = {
      start(request: StartAgentRunRequest): Promise<IpcResult<AgentRun>> {
        startRequests.push(request)
        return new Promise<IpcResult<AgentRun>>((resolve) => {
          resolveStart = resolve
        })
      },
      cancel(runId: string): Promise<IpcResult<AgentRun>> {
        cancelledRunIds.push(runId)
        // AgentManager emits agent.cancelled before resolving.
        events.emit('agent.cancelled', { runId })
        return Promise.resolve({ ok: true, data: { ...fakeAgentRun(runId), status: 'cancelled' } })
      },
    }
    const engine = createWorkflowEngine({ runs: store, events, agentManager: agents })

    const created = store.createRun({
      definition: define([{ id: 'impl', type: 'agent', agent: 'fake', runOn: 'always' }]),
    })
    if (!created.ok) throw new Error(created.error.message)
    const run = created.data.run

    const pass = engine.start(run.id, CONTEXT)
    await flush()
    expect(startRequests).toHaveLength(1)

    // Cancel while the launch is still in flight: the cancel must not
    // complete until the launch settled AND the run received it.
    let cancelSettled = false
    const cancelling = engine.cancel(run.id).then((result) => {
      cancelSettled = true
      return result
    })
    await flush()
    expect(cancelSettled).toBe(false)
    expect(cancelledRunIds).toEqual([])

    resolveStart({ ok: true, data: fakeAgentRun('agent-run-1') })
    const cancelled = await cancelling
    expect(cancelled.ok).toBe(true)
    expect(cancelledRunIds).toEqual(['agent-run-1'])

    const finished = await pass
    expect(finished.ok).toBe(true)
    if (finished.ok) expect(finished.data.run.status).toBe('cancelled')
  })
})
