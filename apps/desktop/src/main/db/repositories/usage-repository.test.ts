import Database from 'better-sqlite3'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../migrations'
import { ISO_UTC_PATTERN } from './common'
import { createUsageRepository, type UsageRepository } from './usage-repository'

let connection: Database.Database
let repo: UsageRepository

const T0 = '2026-09-20T00:00:00.000Z'
const T1 = '2026-09-21T00:00:00.000Z'
const T2 = '2026-09-22T00:00:00.000Z'

function insertWorkspace(id: string) {
  connection
    .prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES (?, ?, 'windows', ?, ?, ?)`,
    )
    .run(id, `WS ${id}`, `C:\\dev\\${id}`, T0, T0)
}

function insertRun(id: string, workspaceId: string, agentType: string, profileId?: string) {
  connection
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, account_profile_id, created_at, updated_at)
       VALUES (?, ?, ?, 'completed', 'attended', ?, ?, ?, ?)`,
    )
    .run(id, workspaceId, agentType, `runs/${id}`, profileId ?? null, T0, T0)
}

function setup() {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
  insertWorkspace('ws-1')
  insertWorkspace('ws-2')
  insertRun('run-claude-1', 'ws-1', 'claude', 'profile-a')
  insertRun('run-codex-1', 'ws-1', 'codex', 'profile-b')
  insertRun('run-codex-2', 'ws-2', 'codex')
  repo = createUsageRepository(connection)
}

afterEach(() => {
  connection.close()
})

describe('UsageRepository (TASK-124)', () => {
  it('upsertAdd creates the row on the first observation and accumulates later ones', () => {
    setup()
    const first = repo.upsertAdd(
      {
        runId: 'run-codex-1',
        source: 'codex-exec-json',
        model: 'gpt-5-codex',
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      },
      T1,
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.data.turns).toBe(1)
    expect(first.data.costUsdMicros).toBeUndefined()
    expect(first.data.updatedAt).toBe(T1)

    // Codex turn.completed cadence: every turn adds into the same row.
    const second = repo.upsertAdd(
      {
        runId: 'run-codex-1',
        source: 'codex-exec-json',
        inputTokens: 50,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      T2,
    )
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data).toMatchObject({
      runId: 'run-codex-1',
      source: 'codex-exec-json',
      model: 'gpt-5-codex',
      inputTokens: 150,
      outputTokens: 60,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      turns: 2,
      updatedAt: T2,
    })
  })

  it('keeps cost NULL until the provider reports one, then accumulates reports', () => {
    setup()
    repo.upsertAdd({
      runId: 'run-claude-1',
      source: 'claude-stream-json',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(repo.getByRun('run-claude-1')).toMatchObject({
      ok: true,
      data: { costUsdMicros: undefined },
    })

    const reported = repo.upsertAdd({
      runId: 'run-claude-1',
      source: 'claude-stream-json',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdMicros: 1_500,
    })
    expect(reported.ok && reported.data.costUsdMicros).toBe(1_500)

    // A later observation without cost must not erase the accumulated one.
    const later = repo.upsertAdd({
      runId: 'run-claude-1',
      source: 'claude-stream-json',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(later.ok && later.data.costUsdMicros).toBe(1_500)

    const added = repo.upsertAdd({
      runId: 'run-claude-1',
      source: 'claude-stream-json',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdMicros: 500,
    })
    expect(added.ok && added.data.costUsdMicros).toBe(2_000)
  })

  it('getByRun returns null before the first usage observation', () => {
    setup()
    expect(repo.getByRun('run-codex-2')).toEqual({ ok: true, data: null })
  })

  it('returns rows with validated ISO timestamps', () => {
    setup()
    const written = repo.upsertAdd({
      runId: 'run-claude-1',
      source: 'claude-stream-json',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(written.data.updatedAt).toMatch(ISO_UTC_PATTERN)
  })

  it('lets the CHECK constraint fail negative token writes (no clamping)', () => {
    setup()
    const negative = repo.upsertAdd({
      runId: 'run-claude-1',
      source: 'claude-stream-json',
      inputTokens: -1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(negative.ok).toBe(false)
    if (negative.ok) return
    expect(negative.error.code).toBe('UNKNOWN')
    // The failed write left no row behind.
    expect(repo.getByRun('run-claude-1')).toEqual({ ok: true, data: null })
  })

  it('lets the CHECK constraint fail a negative ACCUMULATION (existing row goes negative)', () => {
    setup()
    repo.upsertAdd({
      runId: 'run-claude-1',
      source: 'claude-stream-json',
      inputTokens: 5,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    const negative = repo.upsertAdd({
      runId: 'run-claude-1',
      source: 'claude-stream-json',
      inputTokens: -10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(negative.ok).toBe(false)
    // The surviving row keeps its pre-failure values.
    expect(repo.getByRun('run-claude-1')).toMatchObject({ ok: true, data: { inputTokens: 5 } })
  })

  it('ON DELETE CASCADE removes the usage row with its run', () => {
    setup()
    repo.upsertAdd({
      runId: 'run-claude-1',
      source: 'claude-stream-json',
      inputTokens: 5,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    connection.prepare("DELETE FROM agent_runs WHERE id = 'run-claude-1'").run()
    expect(repo.getByRun('run-claude-1')).toEqual({ ok: true, data: null })
  })

  it('summarize joins agent_runs for the workspace / agentType / accountProfileId dimensions', () => {
    setup()
    repo.upsertAdd(
      {
        runId: 'run-claude-1',
        source: 'claude-stream-json',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 900,
      },
      T2,
    )
    repo.upsertAdd(
      {
        runId: 'run-codex-1',
        source: 'codex-exec-json',
        inputTokens: 200,
        outputTokens: 80,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
      },
      T2,
    )
    repo.upsertAdd(
      {
        runId: 'run-codex-1',
        source: 'codex-exec-json',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      T2,
    )
    repo.upsertAdd(
      {
        runId: 'run-codex-2',
        source: 'codex-exec-json',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 100,
      },
      T2,
    )

    const all = repo.summarize({ since: T1 })
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.data).toEqual([
      {
        workspaceId: 'ws-1',
        agentType: 'claude',
        accountProfileId: 'profile-a',
        runs: 1,
        turns: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 900,
      },
      {
        workspaceId: 'ws-1',
        agentType: 'codex',
        accountProfileId: 'profile-b',
        runs: 1,
        turns: 2,
        inputTokens: 300,
        outputTokens: 100,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        costUsdMicros: undefined,
      },
      {
        workspaceId: 'ws-2',
        agentType: 'codex',
        accountProfileId: undefined,
        runs: 1,
        turns: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsdMicros: 100,
      },
    ])
  })

  it('summarize filters by workspaceId / agentType / accountProfileId and the since window', () => {
    setup()
    // Stale row: updated BEFORE the window, must be excluded everywhere.
    repo.upsertAdd(
      {
        runId: 'run-claude-1',
        source: 'claude-stream-json',
        inputTokens: 999,
        outputTokens: 999,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      T0,
    )
    repo.upsertAdd(
      {
        runId: 'run-codex-1',
        source: 'codex-exec-json',
        inputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      T2,
    )
    repo.upsertAdd(
      {
        runId: 'run-codex-2',
        source: 'codex-exec-json',
        inputTokens: 20,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      T2,
    )

    const byWorkspace = repo.summarize({ workspaceId: 'ws-1', since: T1 })
    expect(byWorkspace.ok).toBe(true)
    if (!byWorkspace.ok) return
    expect(byWorkspace.data).toHaveLength(1)
    expect(byWorkspace.data[0]).toMatchObject({
      workspaceId: 'ws-1',
      agentType: 'codex',
      accountProfileId: 'profile-b',
      inputTokens: 10,
    })

    const byAgent = repo.summarize({ agentType: 'codex', since: T1 })
    expect(byAgent.ok && byAgent.data.map((bucket) => bucket.workspaceId).sort()).toEqual([
      'ws-1',
      'ws-2',
    ])

    const byProfile = repo.summarize({ accountProfileId: 'profile-b', since: T1 })
    expect(byProfile.ok).toBe(true)
    if (!byProfile.ok) return
    expect(byProfile.data).toHaveLength(1)
    expect(byProfile.data[0]).toMatchObject({ accountProfileId: 'profile-b', inputTokens: 10 })

    // The since window excludes the stale claude row entirely.
    const all = repo.summarize({ since: T1 })
    expect(all.ok && all.data.some((bucket) => bucket.agentType === 'claude')).toBe(false)
    const everything = repo.summarize({ since: '1970-01-01T00:00:00.000Z' })
    expect(everything.ok && everything.data).toHaveLength(3)
  })
})
