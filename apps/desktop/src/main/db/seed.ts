import { randomUUID } from 'node:crypto'

import type Database from 'better-sqlite3'

/**
 * Development seed (TASK-090): builds the full relation graph
 * "1 Workspace / 1 Task / 1 WorkflowRun / 2 AgentRun / 1 ReviewPanel"
 * (plus the supporting criteria / worktree / artifact / review rows) so UI
 * development has realistic data before the real Runtime exists.
 *
 * Column values follow the plan §139.1 enum comments (kept in sync with
 * packages/contracts via enums.test.ts). `run_dir` below is a placeholder
 * string — real paths come from the TASK-078 paths module at runtime.
 */
export interface SeedGraph {
  readonly workspaceId: string
  readonly taskId: string
  readonly criteriaSetId: string
  readonly criterionIds: readonly [string, string]
  readonly worktreeId: string
  readonly workflowRunId: string
  readonly workflowStepId: string
  readonly implementerRunId: string
  readonly reviewerRunId: string
  readonly artifactId: string
  readonly handoffId: string
  readonly reviewPanelId: string
  readonly reviewPanelMemberIds: readonly [string, string]
  readonly reviewFindingId: string
  readonly criterionScoreId: string
  readonly memoryId: string
  readonly permissionRuleId: string
  readonly permissionAuditId: number
}

export function seedDatabase(connection: Database.Database, now?: string): SeedGraph {
  const at = now ?? new Date().toISOString()

  const workspaceId = randomUUID()
  const taskId = randomUUID()
  const criteriaSetId = randomUUID()
  const criterionIds = [randomUUID(), randomUUID()] as const
  const worktreeId = randomUUID()
  const workflowRunId = randomUUID()
  const workflowStepId = randomUUID()
  const implementerRunId = randomUUID()
  const reviewerRunId = randomUUID()
  const artifactId = randomUUID()
  const handoffId = randomUUID()
  const reviewPanelId = randomUUID()
  const reviewPanelMemberIds = [randomUUID(), randomUUID()] as const
  const reviewFindingId = randomUUID()
  const criterionScoreId = randomUUID()
  const memoryId = randomUUID()
  const permissionRuleId = randomUUID()
  let permissionAuditId = 0

  connection.transaction(() => {
    // Paths embed the workspace id so seeding the same database twice does not
    // trip idx_workspaces_runtime_path (runtime_kind, wsl_distro, path).
    const workspacePath = `C:\\dev\\seed-workspace-${workspaceId}`
    connection
      .prepare(
        `INSERT INTO workspaces (id, name, runtime_kind, path, git_root, default_branch, last_opened_at, created_at, updated_at)
         VALUES (?, ?, 'windows', ?, ?, 'main', ?, ?, ?)`,
      )
      .run(workspaceId, 'Seed Workspace', workspacePath, workspacePath, at, at, at)

    connection
      .prepare(
        `INSERT INTO tasks (id, workspace_id, title, description, status, created_at, updated_at)
         VALUES (?, ?, 'Seed Task', 'Seeded demo task for UI development', 'running', ?, ?)`,
      )
      .run(taskId, workspaceId, at, at)

    connection
      .prepare(
        `INSERT INTO acceptance_criteria_sets (id, task_id, version, status, confirmed_at, created_at)
         VALUES (?, ?, 1, 'confirmed', ?, ?)`,
      )
      .run(criteriaSetId, taskId, at, at)

    const insertCriterion = connection.prepare(
      `INSERT INTO acceptance_criteria (id, criteria_set_id, ordinal, description, category, created_at)
       VALUES (?, ?, ?, ?, 'functional', ?)`,
    )
    insertCriterion.run(criterionIds[0], criteriaSetId, 1, 'Schema matches plan §139.1', at)
    insertCriterion.run(criterionIds[1], criteriaSetId, 2, 'All unit tests pass', at)

    connection
      .prepare(
        `INSERT INTO worktrees (id, workspace_id, run_id, branch, base_branch, path, state, isolation, created_at, updated_at)
         VALUES (?, ?, ?, 'teskra/seed-run', 'main', ?, 'ready', 'worktree', ?, ?)`,
      )
      .run(worktreeId, workspaceId, implementerRunId, 'C:\\dev\\seed-workspace-wt', at, at)

    connection
      .prepare(
        `INSERT INTO workflow_runs (id, task_id, workflow_definition_id, definition_json, status, current_iteration, total_iterations, criteria_set_id, created_at)
         VALUES (?, ?, 'default', '{"nodes":["implement","review"]}', 'running', 1, 1, ?, ?)`,
      )
      .run(workflowRunId, taskId, criteriaSetId, at)

    connection
      .prepare(
        `INSERT INTO workflow_steps (id, workflow_run_id, node_id, node_type, status, iteration, attempt, created_at)
         VALUES (?, ?, 'implement', 'agent', 'completed', 1, 1, ?)`,
      )
      .run(workflowStepId, workflowRunId, at)

    connection
      .prepare(
        `INSERT INTO agent_runs (id, task_id, workspace_id, workflow_run_id, workflow_step_id, agent_type, role, approval_mode, status, worktree_id, execution_mode, criteria_set_id, run_dir, prompt, started_at, finished_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'codex', 'implementer', 'safe-auto', 'completed', ?, 'orchestrated', ?, ?, 'Implement the seed task', ?, ?, ?, ?)`,
      )
      .run(
        implementerRunId,
        taskId,
        workspaceId,
        workflowRunId,
        workflowStepId,
        worktreeId,
        criteriaSetId,
        `seed-run-dir/${implementerRunId}`,
        at,
        at,
        at,
        at,
      )

    connection
      .prepare(
        `INSERT INTO agent_runs (id, task_id, workspace_id, workflow_run_id, agent_type, role, approval_mode, status, execution_mode, criteria_set_id, run_dir, prompt, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'claude-code', 'reviewer', 'read-only', 'running', 'orchestrated', ?, ?, 'Review the implementation', ?, ?, ?)`,
      )
      .run(
        reviewerRunId,
        taskId,
        workspaceId,
        workflowRunId,
        criteriaSetId,
        `seed-run-dir/${reviewerRunId}`,
        at,
        at,
        at,
      )

    const insertEvent = connection.prepare(
      `INSERT INTO agent_events (run_id, seq, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    insertEvent.run(implementerRunId, 1, 'run.started', '{"prompt":"Implement the seed task"}', at)
    insertEvent.run(implementerRunId, 2, 'run.finished', '{"exitCode":0}', at)

    connection
      .prepare(
        `INSERT INTO artifacts (id, task_id, run_id, type, name, content, created_at)
         VALUES (?, ?, ?, 'implementation', 'implementation.md', '# Seed implementation', ?)`,
      )
      .run(artifactId, taskId, implementerRunId, at)

    connection
      .prepare(
        `INSERT INTO handoffs (id, run_id, type, payload_json, raw_path, parse_status, created_at)
         VALUES (?, ?, 'implementation', '{"summary":"done"}', 'handoff/implementation.json', 'ok', ?)`,
      )
      .run(handoffId, implementerRunId, at)

    connection
      .prepare(
        `INSERT INTO review_panels (id, task_id, workflow_run_id, target_artifact_id, criteria_set_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(reviewPanelId, taskId, workflowRunId, artifactId, criteriaSetId, at)

    const insertMember = connection.prepare(
      `INSERT INTO review_panel_members (id, panel_id, run_id, agent_id, verdict, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    insertMember.run(reviewPanelMemberIds[0], reviewPanelId, implementerRunId, 'codex', null, at)
    insertMember.run(
      reviewPanelMemberIds[1],
      reviewPanelId,
      reviewerRunId,
      'claude-code',
      'approve',
      at,
    )

    connection
      .prepare(
        `INSERT INTO review_findings (id, run_id, panel_id, severity, title, description, file, line, criterion_id, created_at)
         VALUES (?, ?, ?, 'low', 'Seed finding', 'Placeholder finding for UI development', 'src/index.ts', 1, ?, ?)`,
      )
      .run(reviewFindingId, reviewerRunId, reviewPanelId, criterionIds[0], at)

    connection
      .prepare(
        `INSERT INTO criterion_scores (id, run_id, criterion_id, result, evidence_json, created_at)
         VALUES (?, ?, ?, 'pass', '{"note":"seed"}', ?)`,
      )
      .run(criterionScoreId, reviewerRunId, criterionIds[0], at)

    connection
      .prepare(
        `INSERT INTO memories (id, workspace_id, type, content, source, created_at, updated_at)
         VALUES (?, ?, 'summary', 'Seed memory for UI development', 'manual', ?, ?)`,
      )
      .run(memoryId, workspaceId, at, at)

    connection
      .prepare(
        `INSERT INTO permission_rules (id, workspace_id, agent_type, command_pattern, risk_level, action, scope, created_at)
         VALUES (?, ?, NULL, 'rm -rf *', 'critical', 'deny', 'persistent', ?)`,
      )
      .run(permissionRuleId, workspaceId, at)

    permissionAuditId = Number(
      connection
        .prepare(
          `INSERT INTO permission_audit (run_id, command, cwd, risk_level, matched_rule_id, detected_at, created_at)
           VALUES (?, 'rm -rf build', ?, 'critical', ?, ?, ?)`,
        )
        .run(implementerRunId, 'C:\\dev\\seed-workspace', permissionRuleId, at, at).lastInsertRowid,
    )
  })()

  return {
    workspaceId,
    taskId,
    criteriaSetId,
    criterionIds,
    worktreeId,
    workflowRunId,
    workflowStepId,
    implementerRunId,
    reviewerRunId,
    artifactId,
    handoffId,
    reviewPanelId,
    reviewPanelMemberIds,
    reviewFindingId,
    criterionScoreId,
    memoryId,
    permissionRuleId,
    permissionAuditId,
  }
}
