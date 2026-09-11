import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkflowNode, WorkflowRun, WorkflowStep } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import { createCriteriaRepository, createReviewRepository } from '../db/repositories'
import {
  createCriteriaGateStepExecutor,
  latestCriterionScores,
} from './criteria-gate-step-executor'
import type { WorkflowStepExecution } from './workflow-engine'

/**
 * TASK-063 criteria-gate executor: auto-evaluates the persisted criterion
 * scores against the run's anchored criteria set — 'pass' only when every
 * criterion scored 'pass'; required fail / unknown / missing set all fail.
 */

const AT = '2026-09-10T00:00:00.000Z'

const databases: Database.Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

const GATE_NODE: WorkflowNode = { id: 'gate-implement', type: 'criteria-gate', runOn: 'first' }

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'wf-1',
    taskId: 'task-1',
    workflowDefinitionId: 'full',
    definition: { id: 'full', steps: [GATE_NODE] },
    status: 'running',
    currentIteration: 0,
    totalIterations: 8,
    criteriaIteration: 0,
    criteriaSetId: 'set-1',
    createdAt: AT,
    ...overrides,
  }
}

function makeExecution(overrides: Partial<WorkflowRun> = {}): WorkflowStepExecution {
  const step: WorkflowStep = {
    id: 'step-1',
    workflowRunId: 'wf-1',
    nodeId: GATE_NODE.id,
    nodeType: 'criteria-gate',
    status: 'running',
    iteration: 0,
    attempt: 1,
    createdAt: AT,
  }
  return {
    run: makeRun(overrides),
    step,
    node: GATE_NODE,
    context: { workspaceId: 'ws-1' },
    upstreamOutcomes: {},
  }
}

function setup(options?: { confirmed?: boolean; criteria?: { id: string; required?: boolean }[] }) {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(database)
  if (!migrated.ok) throw new Error(migrated.error.message)
  databases.push(database)
  database
    .prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', '${AT}', '${AT}')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at)
       VALUES ('task-1', 'ws-1', 'T', 'running', '${AT}', '${AT}')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO acceptance_criteria_sets (id, task_id, version, status, created_at)
       VALUES ('set-1', 'task-1', 1, '${options?.confirmed === false ? 'draft' : 'confirmed'}', '${AT}')`,
    )
    .run()
  for (const [index, criterion] of (options?.criteria ?? [{ id: 'crit-1' }]).entries()) {
    database
      .prepare(
        `INSERT INTO acceptance_criteria (id, criteria_set_id, ordinal, description, required, created_at)
         VALUES ('${criterion.id}', 'set-1', ${String(index + 1)}, '${criterion.id}', ${criterion.required === false ? 0 : 1}, '${AT}')`,
      )
      .run()
  }
  database
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, task_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
       VALUES ('agent-run-1', 'ws-1', 'task-1', 'codex', 'completed', 'orchestrated', 'runs/agent-run-1', '${AT}', '${AT}')`,
    )
    .run()
  const criteria = createCriteriaRepository(database)
  const reviews = createReviewRepository(database)
  const executor = createCriteriaGateStepExecutor({ reviews, criteria })
  const score = (
    criterionId: string,
    result: 'pass' | 'fail' | 'unknown',
    id = `score-${criterionId}`,
  ) => {
    const recorded = reviews.recordScore({ id, runId: 'agent-run-1', criterionId, result }, AT)
    if (!recorded.ok) throw new Error(recorded.error.message)
  }
  return { executor, score }
}

describe('createCriteriaGateStepExecutor (TASK-063)', () => {
  it('passes only when every criterion of the anchored set scored pass', async () => {
    const { executor, score } = setup({
      criteria: [{ id: 'crit-1' }, { id: 'crit-2', required: false }],
    })
    score('crit-1', 'pass')
    score('crit-2', 'pass')
    const completion = await executor.execute(makeExecution())
    expect(completion.outcome).toBe('pass')
    expect(completion.result).toMatchObject({ criteriaOutcome: 'pass', scored: 2, total: 2 })
  })

  it('fails on a required criterion failure and on unreviewed criteria (never auto-passes)', async () => {
    const failing = setup()
    failing.score('crit-1', 'fail')
    expect((await failing.executor.execute(makeExecution())).outcome).toBe('fail')

    const unreviewed = setup()
    const completion = await unreviewed.executor.execute(makeExecution())
    expect(completion.outcome).toBe('fail')
    expect(completion.result).toMatchObject({ criteriaOutcome: 'unknown', scored: 0, total: 1 })
  })

  it('fails when the run has no criteria set to evaluate or no task at all', async () => {
    const { executor } = setup({ confirmed: false })
    const draftOnly = await executor.execute(makeExecution({ criteriaSetId: undefined }))
    expect(draftOnly.outcome).toBe('fail')
    expect(draftOnly.result?.['reason']).toContain('no confirmed criteria set')

    const taskless = await executor.execute(makeExecution({ taskId: undefined }))
    expect(taskless.outcome).toBe('fail')
  })

  it('falls back to the task-level confirmed set when the run is not anchored', async () => {
    const { executor, score } = setup()
    score('crit-1', 'pass')
    const completion = await executor.execute(makeExecution({ criteriaSetId: undefined }))
    expect(completion.outcome).toBe('pass')
  })

  it('rejects non-criteria-gate nodes', async () => {
    const { executor } = setup()
    const execution = makeExecution()
    const completion = await executor.execute({
      ...execution,
      node: { id: 'x', type: 'shell', command: 'true', runOn: 'always' },
    })
    expect(completion.outcome).toBe('failure')
  })
})

describe('latestCriterionScores', () => {
  it('keeps the newest score per criterion', () => {
    const latest = latestCriterionScores([
      { criterionId: 'a', result: 'fail', createdAt: '2026-09-10T00:00:00.000Z' },
      { criterionId: 'a', result: 'pass', createdAt: '2026-09-10T01:00:00.000Z' },
      { criterionId: 'b', result: 'unknown', createdAt: '2026-09-10T00:30:00.000Z' },
    ])
    expect(latest).toEqual([
      { criterionId: 'a', result: 'pass' },
      { criterionId: 'b', result: 'unknown' },
    ])
  })
})
