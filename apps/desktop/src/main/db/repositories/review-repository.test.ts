import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import { ISO_UTC_PATTERN } from './common'
import { createReviewRepository, type ReviewRepository } from './review-repository'

let connection: Database.Database
let repo: ReviewRepository

function setup() {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
  const at = '2026-09-09T00:00:00.000Z'
  connection
    .prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', '${at}', '${at}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at)
       VALUES ('task-1', 'ws-1', 'T', 'running', '${at}', '${at}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO acceptance_criteria_sets (id, task_id, version, status, created_at)
       VALUES ('cs-1', 'task-1', 1, 'confirmed', '${at}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO acceptance_criteria (id, criteria_set_id, ordinal, description, created_at)
       VALUES ('crit-1', 'cs-1', 1, 'Tests pass', '${at}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, task_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
       VALUES ('run-1', 'ws-1', 'task-1', 'codex', 'running', 'orchestrated', 'runs/run-1', '${at}', '${at}')`,
    )
    .run()
  repo = createReviewRepository(connection)
}

afterEach(() => {
  connection.close()
})

describe('ReviewRepository', () => {
  it('creates a panel and updates it to a completed consensus', () => {
    setup()
    const panel = repo.createPanel({ id: 'panel-1', taskId: 'task-1', criteriaSetId: 'cs-1' })
    expect(panel.ok).toBe(true)
    if (!panel.ok) return
    expect(panel.data.status).toBe('running')
    expect(panel.data.createdAt).toMatch(ISO_UTC_PATTERN)

    const completed = repo.updatePanel('panel-1', {
      status: 'completed',
      consensus: 'approve',
      aggregate: { disagreements: [] },
      completedAt: '2026-09-09T12:00:00.000Z',
    })
    expect(completed.ok).toBe(true)
    if (!completed.ok) return
    expect(completed.data?.consensus).toBe('approve')
    expect(completed.data?.aggregate).toEqual({ disagreements: [] })

    const list = repo.listPanelsByTask('task-1')
    expect(list.ok && list.data.length).toBe(1)
  })

  it('adds members and records their verdicts', () => {
    setup()
    repo.createPanel({ id: 'panel-1', taskId: 'task-1' })
    const member = repo.addMember({
      id: 'm-1',
      panelId: 'panel-1',
      runId: 'run-1',
      agentId: 'codex',
    })
    expect(member.ok && member.data.verdict).toBeUndefined()

    const verdict = repo.setMemberVerdict('m-1', 'changes_requested')
    expect(verdict.ok && verdict.data?.verdict).toBe('changes_requested')

    const members = repo.listMembers('panel-1')
    expect(members.ok && members.data.length).toBe(1)
  })

  it('adds findings with contracts severity and lists them', () => {
    setup()
    repo.createPanel({ id: 'panel-1', taskId: 'task-1' })
    const finding = repo.addFinding({
      id: 'f-1',
      runId: 'run-1',
      panelId: 'panel-1',
      severity: 'high',
      title: 'Unchecked error',
      file: 'src/index.ts',
      line: 42,
      criterionId: 'crit-1',
      evidence: ['src/index.ts:42 returns undefined', 'diff hunk +42'],
    })
    expect(finding.ok).toBe(true)
    if (!finding.ok) return
    expect(finding.data.severity).toBe('high')
    expect(finding.data.evidence).toEqual(['src/index.ts:42 returns undefined', 'diff hunk +42'])

    expect(repo.listFindingsByPanel('panel-1')).toMatchObject({ ok: true })
    const byRun = repo.listFindingsByRun('run-1')
    expect(byRun.ok && byRun.data.length).toBe(1)
  })

  it('lists findings by task via the owning runs and deletes them per run', () => {
    setup()
    connection
      .prepare(
        `INSERT INTO agent_runs (id, workspace_id, task_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
         VALUES ('run-2', 'ws-1', 'task-1', 'claude', 'completed', 'attended', 'runs/run-2', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
      )
      .run()
    repo.addFinding({ id: 'f-1', runId: 'run-1', severity: 'low', title: 'first' })
    repo.addFinding({ id: 'f-2', runId: 'run-2', severity: 'critical', title: 'second' })

    const byTask = repo.listFindingsByTask('task-1')
    expect(byTask.ok && byTask.data.map((finding) => finding.id)).toEqual(['f-1', 'f-2'])
    expect(repo.listFindingsByTask('task-unknown')).toMatchObject({ ok: true, data: [] })

    expect(repo.deleteFindingsByRun('run-1')).toMatchObject({ ok: true, data: true })
    expect(repo.deleteFindingsByRun('run-1')).toMatchObject({ ok: true, data: false })
    const remaining = repo.listFindingsByTask('task-1')
    expect(remaining.ok && remaining.data.map((finding) => finding.id)).toEqual(['f-2'])
  })

  it('upserts criterion scores on (run_id, criterion_id)', () => {
    setup()
    const first = repo.recordScore({
      id: 's-1',
      runId: 'run-1',
      criterionId: 'crit-1',
      result: 'unknown',
    })
    expect(first.ok && first.data.result).toBe('unknown')

    const second = repo.recordScore({
      id: 's-2',
      runId: 'run-1',
      criterionId: 'crit-1',
      result: 'pass',
      evidence: ['vitest run passed: 42/42'],
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data.result).toBe('pass')
    expect(second.data.evidence).toEqual(['vitest run passed: 42/42'])

    const scores = repo.listScoresByRun('run-1')
    expect(scores.ok && scores.data.length).toBe(1)
  })

  it('lists criterion scores by task via the owning runs', () => {
    setup()
    connection
      .prepare(
        `INSERT INTO agent_runs (id, workspace_id, task_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
         VALUES ('run-2', 'ws-1', 'task-1', 'claude', 'completed', 'attended', 'runs/run-2', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
      )
      .run()
    repo.recordScore({ id: 's-1', runId: 'run-1', criterionId: 'crit-1', result: 'pass' })
    repo.recordScore({ id: 's-2', runId: 'run-2', criterionId: 'crit-1', result: 'unknown' })

    const byTask = repo.listScoresByTask('task-1')
    expect(byTask.ok && byTask.data.map((score) => [score.runId, score.result])).toEqual([
      ['run-1', 'pass'],
      ['run-2', 'unknown'],
    ])
    expect(repo.listScoresByTask('task-unknown')).toMatchObject({ ok: true, data: [] })
  })

  it('returns VALIDATION_FAILED for corrupted aggregate_json', () => {
    setup()
    repo.createPanel({ id: 'panel-1', taskId: 'task-1' })
    connection
      .prepare('UPDATE review_panels SET aggregate_json = ? WHERE id = ?')
      .run('{oops', 'panel-1')

    const result = repo.getPanelById('panel-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects a stored severity outside the contracts enum', () => {
    setup()
    repo.addFinding({ id: 'f-1', runId: 'run-1', severity: 'low', title: 'x' })
    connection
      .prepare('UPDATE review_findings SET severity = ? WHERE id = ?')
      .run('catastrophic', 'f-1')

    const result = repo.listFindingsByRun('run-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })
})
