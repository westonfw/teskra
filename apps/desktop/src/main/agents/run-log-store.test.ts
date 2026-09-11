import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRun } from '@teskra/contracts'

import { createTeskraPaths } from '../paths'
import { createRunLogStore } from './run-log-store'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'teskra-run-log-'))
  homes.push(home)
  const paths = createTeskraPaths({ TESKRA_HOME: home })
  const run: AgentRun = {
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
  return { home, paths, run, store: createRunLogStore({ paths }) }
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
