import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import type { HandoffParseStatus } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import { createAgentRunRepository } from '../db/repositories/agent-run-repository'
import { createCriteriaRepository } from '../db/repositories/criteria-repository'
import type { Handoff } from '../db/repositories/handoff-repository'
import {
  createReviewRepository,
  type ReviewRepository,
} from '../db/repositories/review-repository'
import { createReviewCollector, type ReviewCollector } from './review-collector'

const AT = '2026-09-10T00:00:00.000Z'

let connection: Database.Database
let reviews: ReviewRepository
let collector: ReviewCollector

function setup() {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  connection
    .prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', '${AT}', '${AT}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at)
       VALUES ('task-1', 'ws-1', 'T', 'running', '${AT}', '${AT}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO acceptance_criteria_sets (id, task_id, version, status, created_at)
       VALUES ('cs-1', 'task-1', 1, 'confirmed', '${AT}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO acceptance_criteria (id, criteria_set_id, ordinal, description, required, created_at)
       VALUES ('crit-1', 'cs-1', 1, 'Tests pass', 1, '${AT}'),
              ('crit-2', 'cs-1', 2, 'Docs updated', 0, '${AT}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, task_id, agent_type, role, status, execution_mode, run_dir, created_at, updated_at)
       VALUES ('run-1', 'ws-1', 'task-1', 'codex', 'reviewer', 'completed', 'orchestrated', 'runs/run-1', '${AT}', '${AT}'),
              ('run-impl', 'ws-1', 'task-1', 'codex', 'implementer', 'completed', 'orchestrated', 'runs/run-impl', '${AT}', '${AT}')`,
    )
    .run()
  reviews = createReviewRepository(connection)
  let findingSeq = 0
  let scoreSeq = 0
  collector = createReviewCollector({
    reviews,
    runs: createAgentRunRepository(connection),
    criteria: createCriteriaRepository(connection),
    createFindingId: () => `finding-${++findingSeq}`,
    createScoreId: () => `score-${++scoreSeq}`,
    now: () => AT,
  })
}

afterEach(() => {
  connection.close()
})

function handoff(payload: Record<string, unknown>, parseStatus: HandoffParseStatus): Handoff {
  return {
    id: 'handoff-1',
    runId: 'run-1',
    type: 'review',
    payload,
    parseStatus,
    createdAt: AT,
  }
}

function persistedFindings() {
  const listed = reviews.listFindingsByRun('run-1')
  if (!listed.ok) throw new Error(listed.error.message)
  return listed.data
}

describe('ReviewCollector (TASK-053, ADR-0004)', () => {
  it('persists a parse_status=ok handoff findings with file/line/criterion links', () => {
    setup()
    collector.ingest(
      'run-1',
      handoff(
        {
          runId: 'run-1',
          type: 'review',
          summary: 'Reviewed.',
          findings: [
            {
              severity: 'critical',
              title: 'SQL injection',
              description: 'Unsanitized query input.',
              file: 'src/db.ts',
              line: 88,
              criterionId: 'crit-1',
              evidence: ['src/db.ts:88 string concatenation', 'diff hunk +88'],
            },
            { severity: 'low', title: 'Naming nit' },
          ],
        },
        'ok',
      ),
    )

    const findings = persistedFindings()
    expect(findings).toHaveLength(2)
    expect(findings[0]).toMatchObject({
      runId: 'run-1',
      severity: 'critical',
      title: 'SQL injection',
      file: 'src/db.ts',
      line: 88,
      criterionId: 'crit-1',
      evidence: ['src/db.ts:88 string concatenation', 'diff hunk +88'],
    })
    expect(findings[1]).toMatchObject({ severity: 'low', title: 'Naming nit' })
    expect(findings[1]?.criterionId).toBeUndefined()
  })

  it('degrades per finding: invalid items are dropped, valid ones kept', () => {
    setup()
    collector.ingest(
      'run-1',
      handoff(
        {
          runId: 'run-1',
          type: 'review',
          summary: 'Partially malformed.',
          findings: [
            { severity: 'high', title: 'Valid finding', file: 'a.ts' },
            { severity: 'catastrophic', title: 'Unknown severity' },
            'not-an-object',
          ],
        },
        'degraded',
      ),
    )

    const findings = persistedFindings()
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ severity: 'high', title: 'Valid finding' })
  })

  it('keeps a finding whose criterionId does not resolve, without the link', () => {
    setup()
    collector.ingest(
      'run-1',
      handoff(
        {
          runId: 'run-1',
          type: 'review',
          summary: 'Cited a criterion that does not exist.',
          findings: [
            { severity: 'medium', title: 'Hallucinated link', criterionId: 'crit-missing' },
          ],
        },
        'ok',
      ),
    )

    const findings = persistedFindings()
    expect(findings).toHaveLength(1)
    expect(findings[0]?.criterionId).toBeUndefined()
  })

  it('re-ingesting a run replaces its findings instead of duplicating them', () => {
    setup()
    const first = handoff(
      {
        runId: 'run-1',
        type: 'review',
        summary: 'First pass.',
        findings: [{ severity: 'low', title: 'stale' }],
      },
      'ok',
    )
    collector.ingest('run-1', first)
    collector.ingest(
      'run-1',
      handoff(
        {
          runId: 'run-1',
          type: 'review',
          summary: 'Second pass.',
          findings: [{ severity: 'medium', title: 'fresh' }],
        },
        'ok',
      ),
    )

    const findings = persistedFindings()
    expect(findings).toHaveLength(1)
    expect(findings[0]?.title).toBe('fresh')
  })

  it('persists nothing when the handoff has no findings or an empty list', () => {
    setup()
    collector.ingest('run-1', handoff({ runId: 'run-1', type: 'review', summary: 's' }, 'ok'))
    collector.ingest(
      'run-1',
      handoff({ runId: 'run-1', type: 'review', summary: 's', findings: [] }, 'ok'),
    )
    expect(persistedFindings()).toEqual([])
  })
})

describe('ReviewCollector criterion scores (TASK-054)', () => {
  function persistedScores(runId: string) {
    const listed = reviews.listScoresByRun(runId)
    if (!listed.ok) throw new Error(listed.error.message)
    return listed.data
  }

  it('persists pass/fail/unknown per criterion and backfills unreported ones as unknown', () => {
    setup()
    collector.ingest(
      'run-1',
      handoff(
        {
          runId: 'run-1',
          type: 'review',
          summary: 'Reviewed.',
          criterionScores: [
            { criterionId: 'crit-1', result: 'fail', evidence: ['no test covers src/db.ts'] },
          ],
        },
        'ok',
      ),
    )

    const scores = persistedScores('run-1')
    expect(scores).toHaveLength(2)
    expect(scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          criterionId: 'crit-1',
          result: 'fail',
          evidence: ['no test covers src/db.ts'],
        }),
        // Never reported → explicit unknown, never an implicit pass.
        expect.objectContaining({
          criterionId: 'crit-2',
          result: 'unknown',
          evidence: ['The reviewer did not report a result for this criterion.'],
        }),
      ]),
    )
  })

  it('attributes scores to the reviewed run declared via targetRunId', () => {
    setup()
    collector.ingest(
      'run-1',
      handoff(
        {
          runId: 'run-1',
          type: 'review',
          summary: 'Reviewed the implement run.',
          targetRunId: 'run-impl',
          criterionScores: [{ criterionId: 'crit-1', result: 'pass' }],
        },
        'ok',
      ),
    )

    expect(persistedScores('run-impl')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ criterionId: 'crit-1', result: 'pass' }),
        expect.objectContaining({ criterionId: 'crit-2', result: 'unknown' }),
      ]),
    )
    expect(persistedScores('run-1')).toEqual([])
  })

  it('keeps scores on the reviewer run when targetRunId does not resolve', () => {
    setup()
    collector.ingest(
      'run-1',
      handoff(
        {
          runId: 'run-1',
          type: 'review',
          summary: 'Bad target.',
          targetRunId: 'run-missing',
          criterionScores: [{ criterionId: 'crit-1', result: 'pass' }],
        },
        'ok',
      ),
    )

    expect(persistedScores('run-1')).toEqual(
      expect.arrayContaining([expect.objectContaining({ criterionId: 'crit-1', result: 'pass' })]),
    )
    expect(persistedScores('run-missing')).toEqual([])
  })

  it('drops scores for criteria outside the resolved set, per item', () => {
    setup()
    collector.ingest(
      'run-1',
      handoff(
        {
          runId: 'run-1',
          type: 'review',
          summary: 'Partially malformed.',
          criterionScores: [
            { criterionId: 'crit-1', result: 'pass', evidence: ['ok'] },
            { criterionId: 'crit-missing', result: 'pass' },
            { criterionId: 'crit-2', result: 'definitely-not-a-result' },
          ],
        },
        'degraded',
      ),
    )

    const scores = persistedScores('run-1')
    expect(scores).toHaveLength(2)
    expect(scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ criterionId: 'crit-1', result: 'pass' }),
        // crit-2's entry failed validation → treated as unreported.
        expect.objectContaining({ criterionId: 'crit-2', result: 'unknown' }),
      ]),
    )
  })

  it('skips scoring when the run has no confirmed criteria set', () => {
    setup()
    connection.prepare("UPDATE acceptance_criteria_sets SET status = 'draft' WHERE id = 'cs-1'").run()
    collector.ingest(
      'run-1',
      handoff(
        {
          runId: 'run-1',
          type: 'review',
          summary: 'Reviewed.',
          criterionScores: [{ criterionId: 'crit-1', result: 'pass' }],
        },
        'ok',
      ),
    )
    expect(persistedScores('run-1')).toEqual([])
  })

  it('does not touch scores when the handoff has no criterionScores key', () => {
    setup()
    collector.ingest(
      'run-1',
      handoff(
        {
          runId: 'run-1',
          type: 'review',
          summary: 'Findings only.',
          findings: [{ severity: 'low', title: 'nit' }],
        },
        'ok',
      ),
    )
    expect(persistedScores('run-1')).toEqual([])
    expect(persistedFindings()).toHaveLength(1)
  })
})
