import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from './migrations'

/**
 * TASK-090 acceptance: every ON DELETE behavior defined in plan §139.1
 * (including the lines 5472–5491 delete-policy table) is exercised against a
 * migrated database with PRAGMA foreign_keys = ON, plus the agent_events
 * (run_id, seq) unique constraint.
 */

const AT = '2026-09-09T00:00:00.000Z'

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

function insertWorkspace(db: Database.Database, id = 'ws1'): string {
  db.prepare(
    `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
     VALUES (?, 'ws', 'wsl', '/home/dev/repo', ?, ?)`,
  ).run(id, AT, AT)
  return id
}

function insertTask(db: Database.Database, id = 't1', workspaceId = 'ws1'): string {
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at)
     VALUES (?, ?, 'task', 'ready', ?, ?)`,
  ).run(id, workspaceId, AT, AT)
  return id
}

function insertWorktree(db: Database.Database, id = 'wt1', workspaceId = 'ws1'): string {
  db.prepare(
    `INSERT INTO worktrees (id, workspace_id, branch, base_branch, path, state, isolation, created_at, updated_at)
     VALUES (?, ?, 'b', 'main', '/tmp/wt', 'ready', 'worktree', ?, ?)`,
  ).run(id, workspaceId, AT, AT)
  return id
}

function insertCriteriaSet(db: Database.Database, id = 'cs1', taskId = 't1'): string {
  db.prepare(
    `INSERT INTO acceptance_criteria_sets (id, task_id, version, status, created_at)
     VALUES (?, ?, 1, 'draft', ?)`,
  ).run(id, taskId, AT)
  return id
}

function insertCriterion(db: Database.Database, id = 'c1', setId = 'cs1'): string {
  db.prepare(
    `INSERT INTO acceptance_criteria (id, criteria_set_id, ordinal, description, created_at)
     VALUES (?, ?, 1, 'criterion', ?)`,
  ).run(id, setId, AT)
  return id
}

function insertWorkflowRun(
  db: Database.Database,
  id = 'wr1',
  taskId = 't1',
  criteriaSetId: string | null = null,
): string {
  db.prepare(
    `INSERT INTO workflow_runs (id, task_id, workflow_definition_id, definition_json, status, criteria_set_id, created_at)
     VALUES (?, ?, 'def', '{}', 'running', ?, ?)`,
  ).run(id, taskId, criteriaSetId, AT)
  return id
}

function insertWorkflowStep(db: Database.Database, id = 'st1', workflowRunId = 'wr1'): string {
  db.prepare(
    `INSERT INTO workflow_steps (id, workflow_run_id, node_id, node_type, status, created_at)
     VALUES (?, ?, 'n1', 'agent', 'running', ?)`,
  ).run(id, workflowRunId, AT)
  return id
}

function insertAgentRun(
  db: Database.Database,
  id = 'r1',
  workspaceId = 'ws1',
  refs: {
    taskId?: string
    workflowRunId?: string
    workflowStepId?: string
    worktreeId?: string
    criteriaSetId?: string
  } = {},
): string {
  db.prepare(
    `INSERT INTO agent_runs (id, task_id, workspace_id, workflow_run_id, workflow_step_id, agent_type, status, worktree_id, execution_mode, criteria_set_id, run_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'codex', 'running', ?, 'attended', ?, '/runs/r1', ?, ?)`,
  ).run(
    id,
    refs.taskId ?? null,
    workspaceId,
    refs.workflowRunId ?? null,
    refs.workflowStepId ?? null,
    refs.worktreeId ?? null,
    refs.criteriaSetId ?? null,
    AT,
    AT,
  )
  return id
}

function insertArtifact(
  db: Database.Database,
  id = 'a1',
  taskId = 't1',
  runId: string | null = null,
): string {
  db.prepare(
    `INSERT INTO artifacts (id, task_id, run_id, type, name, created_at)
     VALUES (?, ?, ?, 'plan', 'plan.md', ?)`,
  ).run(id, taskId, runId, AT)
  return id
}

function insertReviewPanel(
  db: Database.Database,
  id = 'p1',
  refs: { taskId?: string; workflowRunId?: string; targetArtifactId?: string } = {},
): string {
  db.prepare(
    `INSERT INTO review_panels (id, task_id, workflow_run_id, target_artifact_id, status, created_at)
     VALUES (?, ?, ?, ?, 'running', ?)`,
  ).run(id, refs.taskId ?? 't1', refs.workflowRunId ?? null, refs.targetArtifactId ?? null, AT)
  return id
}

function count(db: Database.Database, table: string, where = '', ...params: unknown[]): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`)
    .get(...params) as { n: number }
  return row.n
}

describe('ON DELETE CASCADE (§139.1)', () => {
  it('deleting a workspace cascades to tasks, worktrees, agent_runs, memories, permission_rules', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertTask(db)
    insertWorktree(db)
    insertAgentRun(db, 'r1', 'ws1', { taskId: 't1' })
    db.prepare(
      `INSERT INTO memories (id, workspace_id, type, content, created_at, updated_at)
       VALUES ('m1', 'ws1', 'summary', 'x', ?, ?)`,
    ).run(AT, AT)
    db.prepare(
      `INSERT INTO permission_rules (id, workspace_id, command_pattern, action, scope, created_at)
       VALUES ('pr1', 'ws1', 'rm *', 'deny', 'persistent', ?)`,
    ).run(AT)

    db.prepare('DELETE FROM workspaces WHERE id = ?').run('ws1')

    for (const table of ['tasks', 'worktrees', 'agent_runs', 'memories', 'permission_rules']) {
      expect(count(db, table), table).toBe(0)
    }
  })

  it('deleting a task cascades to review panels and artifacts; criteria sets survive as orphans (ADR-0008)', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertTask(db)
    insertWorkflowRun(db)
    insertCriteriaSet(db)
    insertReviewPanel(db, 'p1', { taskId: 't1' })
    insertArtifact(db)

    db.prepare('DELETE FROM tasks WHERE id = ?').run('t1')

    // ADR-0008: criteria sets get task_id SET NULL; sweeping unreferenced
    // orphans is TaskRepository.delete's job, not the FK's.
    expect(count(db, 'acceptance_criteria_sets')).toBe(1)
    expect(
      db.prepare('SELECT task_id FROM acceptance_criteria_sets WHERE id = ?').get('cs1'),
    ).toEqual({ task_id: null })
    for (const table of ['review_panels', 'artifacts']) {
      expect(count(db, table), table).toBe(0)
    }
    // ADR-0006 (TASK-056): WorkflowRun 独立于 Task —— 删除 Task 后保留运行记录。
    expect(count(db, 'workflow_runs')).toBe(1)
  })

  it('deleting a workflow_run cascades to workflow_steps', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertTask(db)
    insertWorkflowRun(db)
    insertWorkflowStep(db)

    db.prepare('DELETE FROM workflow_runs WHERE id = ?').run('wr1')
    expect(count(db, 'workflow_steps')).toBe(0)
  })

  it('deleting an agent_run cascades to events, panel members, findings, scores, handoffs, audit', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertTask(db)
    insertCriteriaSet(db)
    insertCriterion(db)
    insertReviewPanel(db)
    insertAgentRun(db, 'r1', 'ws1', { taskId: 't1' })
    db.prepare(
      `INSERT INTO agent_events (run_id, seq, event_type, payload_json, created_at)
       VALUES ('r1', 1, 'run.started', '{}', ?)`,
    ).run(AT)
    db.prepare(
      `INSERT INTO review_panel_members (id, panel_id, run_id, agent_id, created_at)
       VALUES ('pm1', 'p1', 'r1', 'codex', ?)`,
    ).run(AT)
    db.prepare(
      `INSERT INTO review_findings (id, run_id, panel_id, severity, title, created_at)
       VALUES ('f1', 'r1', 'p1', 'low', 'finding', ?)`,
    ).run(AT)
    db.prepare(
      `INSERT INTO criterion_scores (id, run_id, criterion_id, result, created_at)
       VALUES ('s1', 'r1', 'c1', 'pass', ?)`,
    ).run(AT)
    db.prepare(
      `INSERT INTO handoffs (id, run_id, type, parse_status, created_at)
       VALUES ('h1', 'r1', 'implementation', 'ok', ?)`,
    ).run(AT)
    db.prepare(
      `INSERT INTO permission_audit (run_id, command, risk_level, detected_at, created_at)
       VALUES ('r1', 'ls', 'low', ?, ?)`,
    ).run(AT, AT)

    db.prepare('DELETE FROM agent_runs WHERE id = ?').run('r1')

    for (const table of [
      'agent_events',
      'review_panel_members',
      'review_findings',
      'criterion_scores',
      'handoffs',
      'permission_audit',
    ]) {
      expect(count(db, table), table).toBe(0)
    }
  })

  it('deleting an unreferenced criteria set cascades to criteria and their scores', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertTask(db)
    insertCriteriaSet(db)
    insertCriterion(db)
    insertAgentRun(db, 'r1', 'ws1')
    db.prepare(
      `INSERT INTO criterion_scores (id, run_id, criterion_id, result, created_at)
       VALUES ('s1', 'r1', 'c1', 'pass', ?)`,
    ).run(AT)

    db.prepare('DELETE FROM acceptance_criteria_sets WHERE id = ?').run('cs1')

    expect(count(db, 'acceptance_criteria')).toBe(0)
    expect(count(db, 'criterion_scores')).toBe(0)
  })

  it('deleting a review panel cascades to members and findings', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertTask(db)
    insertReviewPanel(db)
    insertAgentRun(db, 'r1', 'ws1')
    db.prepare(
      `INSERT INTO review_panel_members (id, panel_id, run_id, agent_id, created_at)
       VALUES ('pm1', 'p1', 'r1', 'codex', ?)`,
    ).run(AT)
    db.prepare(
      `INSERT INTO review_findings (id, run_id, panel_id, severity, title, created_at)
       VALUES ('f1', 'r1', 'p1', 'low', 'finding', ?)`,
    ).run(AT)

    db.prepare('DELETE FROM review_panels WHERE id = ?').run('p1')

    expect(count(db, 'review_panel_members')).toBe(0)
    expect(count(db, 'review_findings')).toBe(0)
  })
})

describe('ON DELETE SET NULL (§139.1)', () => {
  it('deleting a task sets workflow_runs.task_id to NULL but keeps the run (ADR-0006)', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertTask(db)
    insertWorkflowRun(db)

    db.prepare('DELETE FROM tasks WHERE id = ?').run('t1')

    const run = db.prepare('SELECT task_id FROM workflow_runs WHERE id = ?').get('wr1') as {
      task_id: string | null
    }
    expect(run.task_id).toBeNull()
  })

  it('allows a workflow_run without any task (TASK-056: 独立于 Task)', () => {
    const db = migratedDb()
    db.prepare(
      `INSERT INTO workflow_runs (id, task_id, workflow_definition_id, definition_json, status, created_at)
       VALUES ('wr-solo', NULL, 'def', '{}', 'created', ?)`,
    ).run(AT)
    expect(count(db, 'workflow_runs')).toBe(1)
  })

  it('deleting a task sets agent_runs.task_id to NULL but keeps the audit record', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertTask(db)
    insertAgentRun(db, 'r1', 'ws1', { taskId: 't1' })

    db.prepare('DELETE FROM tasks WHERE id = ?').run('t1')

    const run = db.prepare('SELECT task_id FROM agent_runs WHERE id = ?').get('r1') as {
      task_id: string | null
    }
    expect(run.task_id).toBeNull()
  })

  it('deleting a workflow_run nulls agent_runs.workflow_run_id and review_panels.workflow_run_id', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertTask(db)
    insertWorkflowRun(db)
    insertAgentRun(db, 'r1', 'ws1', { workflowRunId: 'wr1' })
    insertReviewPanel(db, 'p1', { workflowRunId: 'wr1' })

    db.prepare('DELETE FROM workflow_runs WHERE id = ?').run('wr1')

    expect(
      (db.prepare('SELECT workflow_run_id FROM agent_runs WHERE id = ?').get('r1') as never)[
        'workflow_run_id'
      ],
    ).toBeNull()
    expect(
      (db.prepare('SELECT workflow_run_id FROM review_panels WHERE id = ?').get('p1') as never)[
        'workflow_run_id'
      ],
    ).toBeNull()
  })

  it('deleting a workflow_step nulls agent_runs.workflow_step_id', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertTask(db)
    insertWorkflowRun(db)
    insertWorkflowStep(db)
    insertAgentRun(db, 'r1', 'ws1', { workflowStepId: 'st1' })

    db.prepare('DELETE FROM workflow_steps WHERE id = ?').run('st1')

    expect(
      (db.prepare('SELECT workflow_step_id FROM agent_runs WHERE id = ?').get('r1') as never)[
        'workflow_step_id'
      ],
    ).toBeNull()
  })

  it('deleting a worktree nulls agent_runs.worktree_id (GC 后 Run 历史仍可查看)', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertWorktree(db)
    insertAgentRun(db, 'r1', 'ws1', { worktreeId: 'wt1' })

    db.prepare('DELETE FROM worktrees WHERE id = ?').run('wt1')

    expect(
      (db.prepare('SELECT worktree_id FROM agent_runs WHERE id = ?').get('r1') as never)[
        'worktree_id'
      ],
    ).toBeNull()
  })

  it('deleting an agent_run nulls artifacts.run_id', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertTask(db)
    insertAgentRun(db, 'r1', 'ws1')
    insertArtifact(db, 'a1', 't1', 'r1')

    db.prepare('DELETE FROM agent_runs WHERE id = ?').run('r1')

    expect(
      (db.prepare('SELECT run_id FROM artifacts WHERE id = ?').get('a1') as never)['run_id'],
    ).toBeNull()
  })

  it('deleting a permission_rule nulls permission_audit.matched_rule_id', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertAgentRun(db, 'r1', 'ws1')
    db.prepare(
      `INSERT INTO permission_rules (id, workspace_id, command_pattern, action, scope, created_at)
       VALUES ('pr1', 'ws1', 'rm *', 'deny', 'persistent', ?)`,
    ).run(AT)
    db.prepare(
      `INSERT INTO permission_audit (run_id, command, risk_level, matched_rule_id, detected_at, created_at)
       VALUES ('r1', 'rm -rf x', 'high', 'pr1', ?, ?)`,
    ).run(AT, AT)

    db.prepare('DELETE FROM permission_rules WHERE id = ?').run('pr1')

    expect(
      (db.prepare('SELECT matched_rule_id FROM permission_audit').get() as never)[
        'matched_rule_id'
      ],
    ).toBeNull()
  })
})

describe('ON DELETE RESTRICT / NO ACTION (§139.1)', () => {
  it('refuses to delete a criteria set referenced by a workflow_run (RESTRICT)', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertTask(db)
    insertCriteriaSet(db)
    insertWorkflowRun(db, 'wr1', 't1', 'cs1')

    expect(() =>
      db.prepare('DELETE FROM acceptance_criteria_sets WHERE id = ?').run('cs1'),
    ).toThrow(/FOREIGN KEY/)
    expect(count(db, 'acceptance_criteria_sets')).toBe(1)
  })

  it('refuses to delete a criteria set referenced by an agent_run (RESTRICT)', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertTask(db)
    insertCriteriaSet(db)
    insertAgentRun(db, 'r1', 'ws1', { criteriaSetId: 'cs1' })

    expect(() =>
      db.prepare('DELETE FROM acceptance_criteria_sets WHERE id = ?').run('cs1'),
    ).toThrow(/FOREIGN KEY/)
  })

  it('refuses to delete an artifact targeted by a review panel (RESTRICT)', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertTask(db)
    insertArtifact(db)
    insertReviewPanel(db, 'p1', { targetArtifactId: 'a1' })

    expect(() => db.prepare('DELETE FROM artifacts WHERE id = ?').run('a1')).toThrow(/FOREIGN KEY/)
  })

  it('refuses to delete a criterion referenced by a finding (criterion_id has no ON DELETE → NO ACTION)', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertTask(db)
    insertCriteriaSet(db)
    insertCriterion(db)
    insertAgentRun(db, 'r1', 'ws1')
    db.prepare(
      `INSERT INTO review_findings (id, run_id, severity, title, criterion_id, created_at)
       VALUES ('f1', 'r1', 'medium', 'finding', 'c1', ?)`,
    ).run(AT)

    expect(() => db.prepare('DELETE FROM acceptance_criteria WHERE id = ?').run('c1')).toThrow(
      /FOREIGN KEY/,
    )
  })
})

describe('agent_events (run_id, seq) unique constraint (§139.1 line 5327)', () => {
  it('rejects a duplicate (run_id, seq)', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertAgentRun(db, 'r1', 'ws1')
    const insert = db.prepare(
      `INSERT INTO agent_events (run_id, seq, event_type, payload_json, created_at)
       VALUES ('r1', 1, 'run.started', '{}', ?)`,
    )
    insert.run(AT)
    expect(() => insert.run(AT)).toThrow(/UNIQUE/)
  })

  it('allows the same seq on different runs and autoincrements id', () => {
    const db = migratedDb()
    insertWorkspace(db)
    insertAgentRun(db, 'r1', 'ws1')
    insertAgentRun(db, 'r2', 'ws1')
    const insert = db.prepare(
      `INSERT INTO agent_events (run_id, seq, event_type, payload_json, created_at)
       VALUES (?, 1, 'run.started', '{}', ?)`,
    )
    const first = insert.run('r1', AT)
    const second = insert.run('r2', AT)
    expect(Number(second.lastInsertRowid)).toBeGreaterThan(Number(first.lastInsertRowid))
    expect(count(db, 'agent_events')).toBe(2)
  })
})
