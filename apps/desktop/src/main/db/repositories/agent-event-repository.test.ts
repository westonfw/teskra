import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import { ISO_UTC_PATTERN } from './common'
import { createAgentEventRepository, type AgentEventRepository } from './agent-event-repository'

let connection: Database.Database
let repo: AgentEventRepository

function setup() {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
  connection
    .prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
       VALUES ('run-1', 'ws-1', 'codex', 'running', 'attended', 'runs/run-1', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
    )
    .run()
  repo = createAgentEventRepository(connection)
}

afterEach(() => {
  connection.close()
})

describe('AgentEventRepository', () => {
  it('appends events and lists them ordered by seq', () => {
    setup()
    repo.append({ runId: 'run-1', seq: 2, eventType: 'run.finished', payload: { exitCode: 0 } })
    repo.append({ runId: 'run-1', seq: 1, eventType: 'run.started', payload: { prompt: 'go' } })

    const events = repo.listByRun('run-1')
    expect(events.ok).toBe(true)
    if (!events.ok) return
    expect(events.data.map((event) => event.seq)).toEqual([1, 2])
    const first = events.data[0]
    expect(first?.eventType).toBe('run.started')
    expect(first?.payload).toEqual({ prompt: 'go' })
    expect(first?.createdAt).toMatch(ISO_UTC_PATTERN)
  })

  it('tracks nextSeq per run', () => {
    setup()
    expect(repo.nextSeq('run-1')).toEqual({ ok: true, data: 1 })
    repo.append({ runId: 'run-1', seq: 1, eventType: 'a', payload: {} })
    repo.append({ runId: 'run-1', seq: 2, eventType: 'b', payload: {} })
    expect(repo.nextSeq('run-1')).toEqual({ ok: true, data: 3 })
    expect(repo.nextSeq('other-run')).toEqual({ ok: true, data: 1 })
  })

  it('surfaces (run_id, seq) uniqueness violations as structured errors', () => {
    setup()
    repo.append({ runId: 'run-1', seq: 1, eventType: 'a', payload: {} })
    const dup = repo.append({ runId: 'run-1', seq: 1, eventType: 'b', payload: {} })
    expect(dup.ok).toBe(false)
    if (dup.ok) return
    expect(dup.error.code).toBe('UNKNOWN')
  })

  it('pages one event type by seq (TASK-126 list-progress)', () => {
    setup()
    repo.append({ runId: 'run-1', seq: 1, eventType: 'agent.progress', payload: { n: 1 } })
    repo.append({ runId: 'run-1', seq: 2, eventType: 'agent.output', payload: { data: 'x' } })
    repo.append({ runId: 'run-1', seq: 3, eventType: 'agent.progress', payload: { n: 3 } })
    repo.append({ runId: 'run-1', seq: 4, eventType: 'agent.progress', payload: { n: 4 } })

    const all = repo.listByRunAndType('run-1', 'agent.progress')
    expect(all.ok && all.data.map((event) => event.seq)).toEqual([1, 3, 4])

    const paged = repo.listByRunAndType('run-1', 'agent.progress', { afterSeq: 1, limit: 1 })
    expect(paged.ok && paged.data.map((event) => event.seq)).toEqual([3])
    const rest = repo.listByRunAndType('run-1', 'agent.progress', { afterSeq: 3 })
    expect(rest.ok && rest.data.map((event) => event.seq)).toEqual([4])
  })

  it('returns VALIDATION_FAILED for corrupted payload_json', () => {
    setup()
    connection
      .prepare(
        `INSERT INTO agent_events (run_id, seq, event_type, payload_json, created_at)
         VALUES ('run-1', 1, 'a', '???', '2026-09-09T00:00:00.000Z')`,
      )
      .run()

    const result = repo.listByRun('run-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })
})
