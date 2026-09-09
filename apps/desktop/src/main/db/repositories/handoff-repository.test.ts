import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import { ISO_UTC_PATTERN } from './common'
import { createHandoffRepository, type HandoffRepository } from './handoff-repository'

let connection: Database.Database
let repo: HandoffRepository

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
      `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
       VALUES ('run-1', 'ws-1', 'codex', 'completed', 'orchestrated', 'runs/run-1', '${at}', '${at}')`,
    )
    .run()
  repo = createHandoffRepository(connection)
}

afterEach(() => {
  connection.close()
})

describe('HandoffRepository', () => {
  it('saves a parsed WorkerHandoff and resolves it by run', () => {
    setup()
    const saved = repo.save({
      id: 'h-1',
      runId: 'run-1',
      type: 'implementation',
      parseStatus: 'ok',
      payload: {
        runId: 'run-1',
        type: 'implementation',
        summary: 'done',
        filesChanged: ['src/index.ts'],
      },
      rawPath: 'handoff/implementation.json',
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.data.payload).toMatchObject({ summary: 'done' })
    expect(saved.data.createdAt).toMatch(ISO_UTC_PATTERN)
    expect(repo.getById('h-1')).toEqual(saved)
    expect(repo.getByRunId('run-1')).toEqual(saved)
  })

  it('upserts on run_id (one handoff per run)', () => {
    setup()
    repo.save({ id: 'h-1', runId: 'run-1', type: 'implementation', parseStatus: 'missing' })
    const replaced = repo.save({
      id: 'h-2',
      runId: 'run-1',
      type: 'blocker',
      parseStatus: 'degraded',
      payload: { partial: true },
    })
    expect(replaced.ok).toBe(true)
    if (!replaced.ok) return
    expect(replaced.data.id).toBe('h-2')
    expect(replaced.data.type).toBe('blocker')
    expect(repo.getById('h-1')).toEqual({ ok: true, data: null })
  })

  it('accepts a partial payload record when parse_status is degraded', () => {
    setup()
    const saved = repo.save({
      id: 'h-1',
      runId: 'run-1',
      type: 'review',
      parseStatus: 'degraded',
      payload: { summary: 'half-parsed' },
    })
    expect(saved.ok).toBe(true)
  })

  it('VALIDATION_FAILED when parse_status ok but payload is not a WorkerHandoff', () => {
    setup()
    connection
      .prepare(
        `INSERT INTO handoffs (id, run_id, type, payload_json, parse_status, created_at)
         VALUES ('h-1', 'run-1', 'review', '{"unexpected":1}', 'ok', '2026-09-09T00:00:00.000Z')`,
      )
      .run()

    const result = repo.getByRunId('run-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('returns VALIDATION_FAILED for corrupted payload_json instead of throwing', () => {
    setup()
    connection
      .prepare(
        `INSERT INTO handoffs (id, run_id, type, payload_json, parse_status, created_at)
         VALUES ('h-1', 'run-1', 'review', 'not-json', 'degraded', '2026-09-09T00:00:00.000Z')`,
      )
      .run()

    const result = repo.getById('h-1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('VALIDATION_FAILED')
    expect(result.error).not.toHaveProperty('detail')
  })

  it('deletes a handoff', () => {
    setup()
    repo.save({ id: 'h-1', runId: 'run-1', type: 'test', parseStatus: 'missing' })
    expect(repo.delete('h-1')).toEqual({ ok: true, data: true })
  })
})
