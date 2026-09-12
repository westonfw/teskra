import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../db/migrations'
import {
  createHandoffRepository,
  type HandoffRepository,
} from '../db/repositories/handoff-repository'
import { createTeskraPaths, type TeskraPaths } from '../paths'
import { createCommandRunner } from '../process/command-runner'
import { createHandoffCollector, type HandoffCollector } from './handoff-collector'

const homes: string[] = []
let connection: Database.Database | undefined

afterEach(() => {
  connection?.close()
  connection = undefined
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

interface Fixture {
  readonly collector: HandoffCollector
  readonly handoffs: HandoffRepository
  readonly paths: TeskraPaths
}

function setup(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'teskra-handoff-'))
  homes.push(home)
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  const at = '2026-09-10T00:00:00.000Z'
  connection
    .prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-1', 'WS', 'windows', 'C:\\dev\\ws', '${at}', '${at}')`,
    )
    .run()
  connection
    .prepare(
      `INSERT INTO agent_runs (id, workspace_id, agent_type, status, execution_mode, run_dir, created_at, updated_at)
       VALUES ('run-1', 'ws-1', 'fake', 'completed', 'attended', 'runs/run-1', '${at}', '${at}')`,
    )
    .run()
  const paths = createTeskraPaths({ TESKRA_HOME: home })
  const handoffs = createHandoffRepository(connection)
  return {
    paths,
    handoffs,
    collector: createHandoffCollector({
      handoffs,
      paths,
      createHandoffId: () => 'handoff-1',
      now: () => '2026-09-10T00:00:02.000Z',
    }),
  }
}

function runFiles(fixture: Fixture, runId = 'run-1') {
  const files = fixture.paths.runFiles(runId)
  if (!files.ok) throw new Error(files.error.message)
  return files.data
}

describe('HandoffCollector (TASK-051, ADR-0004)', () => {
  it('parses a valid WorkerHandoff file as parse_status ok', () => {
    const fixture = setup()
    const files = runFiles(fixture)
    writeFileSync(
      files.handoff,
      JSON.stringify({
        runId: 'run-1',
        type: 'implementation',
        summary: 'Implemented the feature.',
        filesChanged: ['src/feature.ts'],
        suggestedNextAction: 'Review the diff.',
      }),
      'utf8',
    )

    const collected = fixture.collector.collect('run-1')

    expect(collected).toMatchObject({
      ok: true,
      data: {
        id: 'handoff-1',
        runId: 'run-1',
        type: 'implementation',
        parseStatus: 'ok',
        rawPath: files.handoff,
        payload: { summary: 'Implemented the feature.' },
        createdAt: '2026-09-10T00:00:02.000Z',
      },
    })
    expect(fixture.handoffs.getByRunId('run-1')).toEqual(collected)
  })

  it('keeps the raw file and degrades when the handoff is not valid JSON', () => {
    const fixture = setup()
    const files = runFiles(fixture)
    writeFileSync(files.handoff, '{ definitely-not-valid-json', 'utf8')

    const collected = fixture.collector.collect('run-1')

    expect(collected).toMatchObject({
      ok: true,
      data: { parseStatus: 'degraded', type: 'analysis', rawPath: files.handoff },
    })
    if (collected.ok) expect(collected.data?.payload).toBeUndefined()
    // The raw file is preserved byte-for-byte for later inspection.
    expect(readFileSync(files.handoff, 'utf8')).toBe('{ definitely-not-valid-json')
  })

  it('degrades a schema-invalid JSON handoff while retaining the partial payload', () => {
    const fixture = setup()
    const files = runFiles(fixture)
    writeFileSync(
      files.handoff,
      JSON.stringify({ runId: 'run-1', type: 'review', summary: 42 }),
      'utf8',
    )

    const collected = fixture.collector.collect('run-1')

    expect(collected).toMatchObject({
      ok: true,
      data: {
        parseStatus: 'degraded',
        type: 'review',
        rawPath: files.handoff,
        payload: { summary: 42 },
      },
    })
  })

  it('degrades a valid handoff addressed to a different run', () => {
    const fixture = setup()
    const files = runFiles(fixture)
    writeFileSync(
      files.handoff,
      JSON.stringify({ runId: 'stale-run', type: 'implementation', summary: 'wrong run' }),
      'utf8',
    )

    expect(fixture.collector.collect('run-1')).toMatchObject({
      ok: true,
      data: { parseStatus: 'degraded', rawPath: files.handoff },
    })
  })

  it('falls back to a truncated terminal.log tail when no handoff was written', () => {
    const fixture = setup()
    const files = runFiles(fixture)
    // RunLogStore.initialize() touches handoff.json, so "missing" usually
    // means an empty file rather than an absent one.
    writeFileSync(files.handoff, '', 'utf8')
    const noise = 'x'.repeat(3_000)
    writeFileSync(files.terminal, `early output\n${noise}\nfinal line of output\r\n`, 'utf8')

    const collected = fixture.collector.collect('run-1')

    expect(collected).toMatchObject({
      ok: true,
      data: {
        parseStatus: 'missing',
        type: 'analysis',
        payload: { source: 'terminal.log' },
      },
    })
    if (!collected.ok) throw new Error('expected collection to succeed')
    const summary = collected.data?.payload?.['summary']
    expect(typeof summary).toBe('string')
    if (typeof summary !== 'string') return
    expect(summary.length).toBeLessThanOrEqual(2_000)
    expect(summary.endsWith('final line of output')).toBe(true)
    expect(summary.startsWith('early output')).toBe(false)
  })

  it('records a placeholder summary when the terminal log is empty too', () => {
    const fixture = setup()
    const files = runFiles(fixture)
    writeFileSync(files.terminal, '', 'utf8')

    expect(fixture.collector.collect('run-1')).toMatchObject({
      ok: true,
      data: {
        parseStatus: 'missing',
        payload: { source: 'terminal.log', summary: 'The Agent produced no terminal output.' },
      },
    })
  })

  it('returns an error result instead of throwing when persistence fails', () => {
    const fixture = setup()
    // run-404 has no agent_runs row: the FK constraint makes save() fail.
    const collected = fixture.collector.collect('run-404')

    expect(collected.ok).toBe(false)
  })
})

describe('ADR-0004 .git/info/exclude integration (TASK-043 assertion)', () => {
  it('keeps .teskra/handoff/ and .teskra/artifacts/ out of git status', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'teskra-exclude-'))
    homes.push(repo)
    const commands = createCommandRunner()
    const git = (args: readonly string[]) =>
      commands.run({ command: 'git', args, cwd: repo, timeoutMs: 30_000 })

    expect((await git(['init'])).ok).toBe(true)
    // The exact entries WorktreeManager appends (TASK-043 unit tests assert
    // the append itself; this asserts the resulting git behavior).
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '.teskra/handoff/\n.teskra/artifacts/\n')
    mkdirSync(join(repo, '.teskra', 'handoff'), { recursive: true })
    mkdirSync(join(repo, '.teskra', 'artifacts', 'run-1'), { recursive: true })
    writeFileSync(join(repo, '.teskra', 'handoff', 'run-1.json'), '{}')
    writeFileSync(join(repo, '.teskra', 'artifacts', 'run-1', 'notes.md'), 'artifact')

    const status = await git(['status', '--porcelain'])

    expect(status.ok).toBe(true)
    if (status.ok) expect(status.data.stdout.trim()).toBe('')
  })
})
