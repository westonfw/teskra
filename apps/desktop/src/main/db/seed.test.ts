import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from './migrations'
import { createHandoffRepository } from './repositories/handoff-repository'
import { createReviewRepository } from './repositories/review-repository'
import { seedDatabase } from './seed'

/** TASK-090 acceptance: the seed builds the full demo relation graph. */

const openConnections: Database.Database[] = []

function migratedDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  openConnections.push(db)
  const result = migrateDatabase(db)
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  return db
}

afterEach(() => {
  for (const connection of openConnections.splice(0)) {
    connection.close()
  }
})

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

describe('seedDatabase (TASK-090)', () => {
  it('builds the 1 Workspace / 1 Task / 1 WorkflowRun / 2 AgentRun / 1 ReviewPanel graph', () => {
    const db = migratedDb()
    const graph = seedDatabase(db, '2026-09-09T00:00:00.000Z')

    expect(count(db, 'workspaces')).toBe(1)
    expect(count(db, 'tasks')).toBe(1)
    expect(count(db, 'workflow_runs')).toBe(1)
    expect(count(db, 'agent_runs')).toBe(2)
    expect(count(db, 'review_panels')).toBe(1)

    // Task belongs to the workspace; workflow run belongs to the task.
    expect(db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(graph.taskId)).toEqual({
      workspace_id: graph.workspaceId,
    })
    expect(
      db.prepare('SELECT task_id FROM workflow_runs WHERE id = ?').get(graph.workflowRunId),
    ).toEqual({ task_id: graph.taskId })

    // Both agent runs hang off the same task; the implementer also carries the
    // workflow/step/worktree/criteria references.
    const runs = db
      .prepare('SELECT id, task_id, worktree_id FROM agent_runs ORDER BY created_at, id')
      .all() as { id: string; task_id: string; worktree_id: string | null }[]
    expect(runs.map((run) => run.task_id)).toEqual([graph.taskId, graph.taskId])
    const implementer = db
      .prepare(
        'SELECT workflow_run_id, workflow_step_id, worktree_id, criteria_set_id FROM agent_runs WHERE id = ?',
      )
      .get(graph.implementerRunId)
    expect(implementer).toEqual({
      workflow_run_id: graph.workflowRunId,
      workflow_step_id: graph.workflowStepId,
      worktree_id: graph.worktreeId,
      criteria_set_id: graph.criteriaSetId,
    })

    // The worktree back-pointer matches the authoritative agent_runs.worktree_id
    // direction (§139.1 循环引用处理).
    expect(db.prepare('SELECT run_id FROM worktrees WHERE id = ?').get(graph.worktreeId)).toEqual({
      run_id: graph.implementerRunId,
    })

    // Review panel is fully wired: task, workflow run, target artifact, criteria.
    expect(
      db
        .prepare(
          'SELECT task_id, workflow_run_id, target_artifact_id, criteria_set_id FROM review_panels WHERE id = ?',
        )
        .get(graph.reviewPanelId),
    ).toEqual({
      task_id: graph.taskId,
      workflow_run_id: graph.workflowRunId,
      target_artifact_id: graph.artifactId,
      criteria_set_id: graph.criteriaSetId,
    })

    // Both agent runs are members of the panel.
    const members = db
      .prepare('SELECT run_id FROM review_panel_members WHERE panel_id = ? ORDER BY created_at, id')
      .all(graph.reviewPanelId) as { run_id: string }[]
    expect(members.map((member) => member.run_id).sort()).toEqual(
      [graph.implementerRunId, graph.reviewerRunId].sort(),
    )

    // Supporting rows exist and point at the right parents.
    expect(count(db, 'workflow_steps')).toBe(1)
    expect(count(db, 'worktrees')).toBe(1)
    expect(count(db, 'acceptance_criteria_sets')).toBe(1)
    expect(count(db, 'acceptance_criteria')).toBe(2)
    expect(count(db, 'agent_events')).toBe(2)
    expect(count(db, 'artifacts')).toBe(1)
    expect(count(db, 'handoffs')).toBe(1)
    expect(count(db, 'review_findings')).toBe(1)
    expect(count(db, 'criterion_scores')).toBe(1)
    expect(count(db, 'memories')).toBe(1)
    expect(count(db, 'permission_rules')).toBe(1)
    expect(count(db, 'permission_audit')).toBe(1)

    expect(
      db
        .prepare('SELECT criterion_id FROM review_findings WHERE id = ?')
        .get(graph.reviewFindingId),
    ).toEqual({ criterion_id: graph.criterionIds[0] })
    expect(
      db
        .prepare('SELECT criterion_id FROM criterion_scores WHERE id = ?')
        .get(graph.criterionScoreId),
    ).toEqual({ criterion_id: graph.criterionIds[0] })
    expect(
      db
        .prepare('SELECT matched_rule_id FROM permission_audit WHERE id = ?')
        .get(graph.permissionAuditId),
    ).toEqual({ matched_rule_id: graph.permissionRuleId })
  })

  it('can seed the same database twice (fresh ids, no unique-key collisions)', () => {
    const db = migratedDb()
    const first = seedDatabase(db)
    const second = seedDatabase(db)
    expect(first.workspaceId).not.toBe(second.workspaceId)
    expect(count(db, 'workspaces')).toBe(2)
    expect(count(db, 'agent_runs')).toBe(4)
    expect(count(db, 'review_panels')).toBe(2)
  })

  it('seeds a handoff the Repository layer can read back', () => {
    const db = migratedDb()
    const graph = seedDatabase(db, '2026-09-09T00:00:00.000Z')

    // parse_status 'ok' promises a full WorkerHandoff payload (ADR-0004).
    const handoff = createHandoffRepository(db).getByRunId(graph.implementerRunId)
    expect(handoff.ok).toBe(true)
    if (handoff.ok) {
      expect(handoff.data?.payload).toMatchObject({
        runId: graph.implementerRunId,
        type: 'implementation',
        summary: 'done',
      })
    }
  })

  it('seeds a criterion score the Repository layer can read back', () => {
    const db = migratedDb()
    const graph = seedDatabase(db, '2026-09-09T00:00:00.000Z')

    // evidence_json is the plan §123 string array, not a free-form object.
    const scores = createReviewRepository(db).listScoresByRun(graph.reviewerRunId)
    expect(scores.ok).toBe(true)
    if (scores.ok) {
      expect(scores.data).toHaveLength(1)
    }
  })
})
