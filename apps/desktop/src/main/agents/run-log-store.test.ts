import {
  appendFileSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentRun } from '@teskra/contracts'

import { createTeskraPaths } from '../paths'
import { createRunLogStore } from './run-log-store'

const homes: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

function makeRun(home: string): AgentRun {
  return {
    id: 'run-1',
    workspaceId: 'workspace-1',
    agentType: 'codex',
    status: 'running',
    executionMode: 'attended',
    runDir: join(home, 'runs', 'run-1'),
    prompt: 'Use sk-secret123 without leaking it',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  }
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'teskra-run-log-'))
  homes.push(home)
  const paths = createTeskraPaths({ TESKRA_HOME: home })
  const run = makeRun(home)
  return { home, paths, run, store: createRunLogStore({ paths }) }
}

/** Store with instrumented clock / fsync / open so the P1-1 policy is observable. */
function setupInstrumented() {
  const home = mkdtempSync(join(tmpdir(), 'teskra-run-log-'))
  homes.push(home)
  const paths = createTeskraPaths({ TESKRA_HOME: home })
  const run = makeRun(home)
  let clock = 0
  const fsyncCalls: number[] = []
  const openCalls: string[] = []
  const store = createRunLogStore({
    paths,
    now: () => clock,
    fsyncIntervalMs: 1_000,
    fsync: (fd) => {
      fsyncCalls.push(fd)
    },
    openAppend: (path) => {
      openCalls.push(path)
      return openSync(path, 'a', 0o600)
    },
  })
  return {
    home,
    paths,
    run,
    store,
    fsyncCalls,
    openCalls,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('RunLogStore (TASK-039)', () => {
  it('initializes one complete durable directory per Run', () => {
    const { home, run, store } = setup()

    expect(store.initialize(run)).toEqual({ ok: true, data: undefined })
    expect(readdirSync(join(home, 'runs', 'run-1')).sort()).toEqual([
      'artifacts',
      'diff.patch',
      'events.jsonl',
      'handoff.json',
      'run.json',
      'terminal.log',
    ])
    const manifest = readFileSync(join(home, 'runs', 'run-1', 'run.json'), 'utf8')
    expect(manifest).not.toContain('sk-secret123')
    expect(JSON.parse(manifest)).toMatchObject({
      id: 'run-1',
      prompt: 'Use [redacted] without leaking it',
    })
  })

  it('appends flushed JSONL lines with stable seq and redacts all raw logs', () => {
    const { home, paths, run, store } = setup()
    store.initialize(run)
    expect(
      store.appendEvent(
        run.id,
        'agent.command',
        { command: 'curl -H ghp_secretvalue123' },
        '2026-09-10T00:00:01.000Z',
      ),
    ).toMatchObject({ ok: true, data: { seq: 1 } })
    expect(
      store.appendEvent(
        run.id,
        'agent.output',
        { data: 'token=sk-output456' },
        '2026-09-10T00:00:02.000Z',
      ),
    ).toMatchObject({ ok: true, data: { seq: 2 } })
    store.appendTerminal(run.id, 'token=sk-terminal789\r\n')

    const restarted = createRunLogStore({ paths })
    expect(
      restarted.appendEvent(run.id, 'agent.completed', { exitCode: 0 }, '2026-09-10T00:00:03.000Z'),
    ).toMatchObject({ ok: true, data: { seq: 3 } })

    const rawEvents = readFileSync(join(home, 'runs', run.id, 'events.jsonl'), 'utf8')
    expect(rawEvents.endsWith('\n')).toBe(true)
    expect(rawEvents).not.toMatch(/ghp_secretvalue123|sk-output456/u)
    const events = rawEvents
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { seq: number })
    expect(events.map(({ seq }) => seq)).toEqual([1, 2, 3])
    expect(readFileSync(join(home, 'runs', run.id, 'terminal.log'), 'utf8')).toBe(
      'token=[redacted]\r\n',
    )
  })
})

describe('RunLogStore hot path (P1-1)', () => {
  it('reuses one append handle per log file and reopens lazily after dispose', () => {
    const { home, run, store, openCalls } = setupInstrumented()
    store.initialize(run)

    store.appendTerminal(run.id, 'one')
    store.appendTerminal(run.id, 'two')
    store.appendEvent(run.id, 'agent.output', { data: 'one' }, '2026-09-10T00:00:01.000Z')
    store.appendEvent(run.id, 'agent.output', { data: 'two' }, '2026-09-10T00:00:02.000Z')
    // terminal.log + events.jsonl were each opened exactly once.
    expect(openCalls).toHaveLength(2)

    expect(store.dispose(run.id)).toEqual({ ok: true, data: undefined })
    store.appendTerminal(run.id, 'three')
    // terminal.log was closed by dispose and reopened on demand.
    expect(openCalls).toHaveLength(3)
    expect(readFileSync(join(home, 'runs', run.id, 'terminal.log'), 'utf8')).toBe('onetwothree')
    expect(store.disposeAll()).toEqual({ ok: true, data: undefined })
  })

  it('throttles fsync inside the interval and forces it at flush / dispose / shutdown', () => {
    const { home, run, store, fsyncCalls, advance } = setupInstrumented()
    store.initialize(run)

    store.appendTerminal(run.id, 'a')
    advance(100)
    store.appendTerminal(run.id, 'b')
    advance(100)
    store.appendEvent(run.id, 'agent.output', { data: 'ab' }, '2026-09-10T00:00:01.000Z')
    // Everything landed inside the 1s throttle window: writes are on disk
    // (readable immediately) but nothing was fsynced yet.
    expect(fsyncCalls).toHaveLength(0)
    expect(readFileSync(join(home, 'runs', run.id, 'terminal.log'), 'utf8')).toBe('ab')

    expect(store.flush(run.id)).toEqual({ ok: true, data: undefined })
    expect(fsyncCalls).toHaveLength(2) // both dirty files forced

    store.appendTerminal(run.id, 'c')
    advance(2_000) // throttle interval elapsed — the next hot-path write syncs inline
    store.appendTerminal(run.id, 'd')
    expect(fsyncCalls).toHaveLength(3)

    store.appendTerminal(run.id, 'e') // dirty again inside the window
    expect(store.dispose(run.id)).toEqual({ ok: true, data: undefined })
    expect(fsyncCalls).toHaveLength(4)

    // Idempotent: nothing open and nothing dirty anymore.
    expect(store.dispose(run.id)).toEqual({ ok: true, data: undefined })
    expect(store.flush(run.id)).toEqual({ ok: true, data: undefined })
    expect(store.disposeAll()).toEqual({ ok: true, data: undefined })
    expect(fsyncCalls).toHaveLength(4)
    expect(readFileSync(join(home, 'runs', run.id, 'terminal.log'), 'utf8')).toBe('abcde')
  })

  it('revalidates events.jsonl incrementally instead of reparsing the whole file', () => {
    const { paths, run, store } = setup()
    store.initialize(run)
    store.appendEvent(run.id, 'agent.output', { data: 'a' }, '2026-09-10T00:00:01.000Z')
    store.appendEvent(run.id, 'agent.output', { data: 'b' }, '2026-09-10T00:00:02.000Z')
    const files = paths.runFiles(run.id)
    if (!files.ok) throw new Error(files.error.message)

    const parse = vi.spyOn(JSON, 'parse')
    // Resume-time re-initialize with nothing appended: zero lines to parse.
    expect(store.initialize(run)).toEqual({ ok: true, data: undefined })
    expect(parse).not.toHaveBeenCalled()

    // An externally appended valid line is validated on its own and the seq
    // sequence continues from it.
    appendFileSync(
      files.data.events,
      `${JSON.stringify({ seq: 3, eventType: 'agent.output', payload: {}, createdAt: '2026-09-10T00:00:03.000Z' })}\n`,
      'utf8',
    )
    expect(store.initialize(run)).toEqual({ ok: true, data: undefined })
    expect(parse).toHaveBeenCalledTimes(1)
    expect(
      store.appendEvent(run.id, 'agent.completed', { exitCode: 0 }, '2026-09-10T00:00:04.000Z'),
    ).toMatchObject({ ok: true, data: { seq: 4 } })
  })

  it('rejects a corrupted incremental tail', () => {
    const { paths, run, store } = setup()
    store.initialize(run)
    store.appendEvent(run.id, 'agent.output', { data: 'a' }, '2026-09-10T00:00:01.000Z')
    const files = paths.runFiles(run.id)
    if (!files.ok) throw new Error(files.error.message)
    appendFileSync(
      files.data.events,
      `${JSON.stringify({ seq: 5, eventType: 'agent.output', payload: {}, createdAt: '2026-09-10T00:00:02.000Z' })}\n`,
      'utf8',
    )

    expect(store.initialize(run).ok).toBe(false)
  })

  it('falls back to full validation when the events file shrank externally', () => {
    const { paths, run, store } = setup()
    store.initialize(run)
    store.appendEvent(run.id, 'agent.output', { data: 'a' }, '2026-09-10T00:00:01.000Z')
    store.appendEvent(run.id, 'agent.output', { data: 'b' }, '2026-09-10T00:00:02.000Z')
    const files = paths.runFiles(run.id)
    if (!files.ok) throw new Error(files.error.message)
    writeFileSync(
      files.data.events,
      `${JSON.stringify({ seq: 1, eventType: 'agent.output', payload: {}, createdAt: '2026-09-10T00:00:01.000Z' })}\n`,
      'utf8',
    )

    expect(store.initialize(run)).toEqual({ ok: true, data: undefined })
    expect(
      store.appendEvent(run.id, 'agent.resumed', {}, '2026-09-10T00:00:03.000Z'),
    ).toMatchObject({ ok: true, data: { seq: 2 } })
  })

  it('drops the per-Run seq and validation caches on dispose (P2-4)', () => {
    const { paths, run, store } = setup()
    store.initialize(run)
    store.appendEvent(run.id, 'agent.output', { data: 'a' }, '2026-09-10T00:00:01.000Z')
    expect(store.dispose(run.id)).toEqual({ ok: true, data: undefined })

    // An external writer appended a line after dispose; with the caches
    // dropped, the next append revalidates from disk instead of reusing the
    // stale in-memory seq (which would write a duplicate seq 2).
    const files = paths.runFiles(run.id)
    if (!files.ok) throw new Error(files.error.message)
    appendFileSync(
      files.data.events,
      `${JSON.stringify({ seq: 2, eventType: 'agent.output', payload: {}, createdAt: '2026-09-10T00:00:02.000Z' })}\n`,
      'utf8',
    )
    expect(
      store.appendEvent(run.id, 'agent.completed', { exitCode: 0 }, '2026-09-10T00:00:03.000Z'),
    ).toMatchObject({ ok: true, data: { seq: 3 } })
  })
})

describe('RunLogStore terminal tail reads (P1-6)', () => {
  it('reads the tail without leaking a split multi-byte character', () => {
    const { run, store } = setup()
    store.initialize(run)
    store.appendTerminal(run.id, 'a世b')

    expect(store.readTerminalTail(run.id, 1_000)).toEqual({ ok: true, data: 'a世b' })
    // '世' is 3 bytes; a 2-byte tail starts on its last byte and must drop the
    // resulting U+FFFD instead of returning mojibake.
    expect(store.readTerminalTail(run.id, 2)).toEqual({ ok: true, data: 'b' })
    expect(store.readTerminalTail(run.id, 4)).toEqual({ ok: true, data: '世b' })
  })

  it('returns null when the terminal log was collected', () => {
    const { store } = setup()
    expect(store.readTerminalTail('run-gone', 1_000)).toEqual({ ok: true, data: null })
  })
})
