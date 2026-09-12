import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkbenchEvents } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import {
  createAgentRunRepository,
  createArtifactRepository,
  createTaskRepository,
  createWorkspaceRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createTeskraPaths } from '../paths'
import { createArtifactStore, resolveArtifactPath, type ArtifactStore } from './artifact-store'

const NOW = '2026-09-10T00:00:00.000Z'

let home: string
let connection: Database.Database
let events: EventBus<WorkbenchEvents>
let store: ArtifactStore
let idCounter: number

function nextId(): string {
  idCounter += 1
  return `id-${String(idCounter)}`
}

function createStore(maxFileBytes?: number): ArtifactStore {
  return createArtifactStore({
    artifacts: createArtifactRepository(connection),
    tasks: createTaskRepository(connection),
    runs: createAgentRunRepository(connection),
    events,
    paths: createTeskraPaths({ TESKRA_HOME: home }),
    createId: nextId,
    now: () => NOW,
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
  })
}

let symlinksChecked = false
let symlinksAvailable = false

// Windows blocks symlink creation without Developer Mode or elevation (EPERM).
function symlinksSupported(): boolean {
  if (!symlinksChecked) {
    symlinksChecked = true
    const probe = mkdtempSync(join(tmpdir(), 'teskra-symlink-probe-'))
    try {
      writeFileSync(join(probe, 'target.txt'), 'x')
      symlinkSync(join(probe, 'target.txt'), join(probe, 'link.txt'))
      symlinkSync(probe, join(probe, 'link-dir'))
      symlinksAvailable = true
    } catch {
      symlinksAvailable = false
    } finally {
      rmSync(probe, { recursive: true, force: true })
    }
  }
  return symlinksAvailable
}

function createRun(id: string, taskId?: string): void {
  const created = createAgentRunRepository(connection).create({
    id,
    workspaceId: 'workspace-1',
    ...(taskId === undefined ? {} : { taskId }),
    agentType: 'codex',
    executionMode: 'attended',
    runDir: `/runs/${id}`,
  })
  if (!created.ok) throw new Error(created.error.message)
}

/** Writes a file into the Run's artifact directory and returns its name. */
function writeRunFile(runId: string, name: string, content: string): string {
  const files = createTeskraPaths({ TESKRA_HOME: home }).runFiles(runId)
  if (!files.ok) throw new Error(files.error.message)
  writeFileSync(join(files.data.artifacts, name), content)
  return name
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'teskra-artifacts-'))
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  const workspaces = createWorkspaceRepository(connection)
  const workspace = workspaces.create({
    id: 'workspace-1',
    name: 'Demo',
    runtime: { kind: 'windows' },
    path: 'C:\\repo',
  })
  if (!workspace.ok) throw new Error(workspace.error.message)
  const tasks = createTaskRepository(connection)
  for (const id of ['task-1', 'task-2']) {
    const task = tasks.create({ id, workspaceId: 'workspace-1', title: id }, NOW)
    if (!task.ok) throw new Error(task.error.message)
  }
  createRun('run-1', 'task-1')
  createRun('run-2', 'task-2')
  createRun('run-3')
  events = createEventBus<WorkbenchEvents>()
  idCounter = 0
  store = createStore()
})

afterEach(() => {
  connection.close()
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

describe('resolveArtifactPath', () => {
  it('keeps relative paths inside the artifact directory and rejects escapes', () => {
    const artifactDir = '/run/artifacts'
    // The resolved form follows the host path semantics (a POSIX-shaped base
    // gains the current drive on Windows), so compare via node:path.
    expect(resolveArtifactPath(artifactDir, 'plan.md')).toBe(resolve(artifactDir, 'plan.md'))
    expect(resolveArtifactPath(artifactDir, 'nested/plan.md')).toBe(
      resolve(artifactDir, 'nested/plan.md'),
    )
    expect(resolveArtifactPath(artifactDir, '../evil.txt')).toBeUndefined()
    expect(resolveArtifactPath(artifactDir, '../../evil.txt')).toBeUndefined()
    expect(resolveArtifactPath(artifactDir, '/etc/passwd')).toBeUndefined()
    // Windows-shaped escapes are rejected on every host: an agent running in
    // WSL may emit backslash paths that the host must not resolve leniently.
    expect(resolveArtifactPath(artifactDir, '..\\evil.txt')).toBeUndefined()
    expect(resolveArtifactPath(artifactDir, 'C:\\evil.txt')).toBeUndefined()
  })
})

describe('ArtifactStore.record (TASK-050)', () => {
  it('records an inline text artifact attached to a Task and a Run', () => {
    const updatedEvent = vi.fn()
    events.subscribe('task.updated', updatedEvent)

    const recorded = store.record({
      taskId: 'task-1',
      runId: 'run-1',
      type: 'plan',
      name: 'plan',
      content: '# Plan',
    })
    expect(recorded).toMatchObject({
      ok: true,
      data: { taskId: 'task-1', runId: 'run-1', type: 'plan', content: '# Plan' },
    })
    expect(updatedEvent).toHaveBeenCalledWith({ taskId: 'task-1' })
  })

  it('records a metadata artifact without a Run', () => {
    const recorded = store.record({
      taskId: 'task-1',
      type: 'test-result',
      name: 'vitest summary',
      metadata: { passed: 12, failed: 0 },
    })
    expect(recorded).toMatchObject({
      ok: true,
      data: { taskId: 'task-1', metadata: { passed: 12, failed: 0 } },
    })
    expect(recorded.ok && recorded.data.runId).toBeUndefined()
  })

  it('rejects a missing Task, a missing Run, and a Run of a different Task', () => {
    expect(
      store.record({ taskId: 'missing', type: 'plan', name: 'p', content: 'x' }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(
      store.record({ taskId: 'task-1', runId: 'missing', type: 'plan', name: 'p', content: 'x' }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(
      store.record({ taskId: 'task-1', runId: 'run-2', type: 'plan', name: 'p', content: 'x' }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('rejects file artifacts without a Run and paths escaping the artifact directory', () => {
    expect(
      store.record({ taskId: 'task-1', type: 'diff', name: 'd', filePath: 'diff.patch' }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    for (const filePath of ['../evil.txt', '../../evil.txt', '/etc/passwd']) {
      expect(
        store.record({
          taskId: 'task-1',
          runId: 'run-1',
          type: 'diff',
          name: 'd',
          filePath,
        }),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    }
  })
})

describe('ArtifactStore.get (TASK-050)', () => {
  it('resolves inline text and metadata payloads', () => {
    const text = store.record({ taskId: 'task-1', type: 'plan', name: 'p', content: '# Plan' })
    if (!text.ok) throw new Error(text.error.message)
    expect(store.get({ artifactId: text.data.id })).toEqual({
      ok: true,
      data: { artifact: text.data, content: '# Plan', truncated: false },
    })

    const meta = store.record({
      taskId: 'task-1',
      type: 'decision',
      name: 'd',
      metadata: { chose: 'sqlite' },
    })
    if (!meta.ok) throw new Error(meta.error.message)
    const resolved = store.get({ artifactId: meta.data.id })
    expect(resolved).toMatchObject({ ok: true, data: { truncated: false } })
    expect(resolved.ok && JSON.parse(resolved.data?.content ?? '')).toEqual({ chose: 'sqlite' })

    expect(store.get({ artifactId: 'missing' })).toEqual({ ok: true, data: null })
  })

  it('reads file payloads from the Run artifact directory', () => {
    writeRunFile('run-1', 'implementation.md', '# Done\n\nDetails.')
    const recorded = store.record({
      taskId: 'task-1',
      runId: 'run-1',
      type: 'implementation',
      name: 'implementation.md',
      filePath: 'implementation.md',
    })
    if (!recorded.ok) throw new Error(recorded.error.message)
    expect(store.get({ artifactId: recorded.data.id })).toMatchObject({
      ok: true,
      data: { content: '# Done\n\nDetails.', truncated: false },
    })
  })

  it('truncates file payloads beyond the read cap', () => {
    const capped = createStore(8)
    writeRunFile('run-1', 'big.log', '0123456789ABCDEF')
    const recorded = capped.record({
      taskId: 'task-1',
      runId: 'run-1',
      type: 'test-result',
      name: 'big.log',
      filePath: 'big.log',
    })
    if (!recorded.ok) throw new Error(recorded.error.message)
    expect(capped.get({ artifactId: recorded.data.id })).toMatchObject({
      ok: true,
      data: { content: '01234567', truncated: true },
    })
  })

  it('rejects a stored file path that escapes the artifact directory', () => {
    const artifacts = createArtifactRepository(connection)
    const inserted = artifacts.create(
      {
        id: 'evil',
        taskId: 'task-1',
        runId: 'run-1',
        type: 'diff',
        name: 'evil',
        filePath: '../../../etc/passwd',
      },
      NOW,
    )
    if (!inserted.ok) throw new Error(inserted.error.message)
    expect(store.get({ artifactId: 'evil' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
  })

  it('rejects file payloads behind a symlink escaping the artifact directory', (ctx) => {
    if (!symlinksSupported()) ctx.skip()
    const files = createTeskraPaths({ TESKRA_HOME: home }).runFiles('run-1')
    if (!files.ok) throw new Error(files.error.message)
    const outside = join(home, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET')
    symlinkSync(join(outside, 'secret.txt'), join(files.data.artifacts, 'leak.txt'))
    symlinkSync(outside, join(files.data.artifacts, 'linked-dir'))

    for (const [name, filePath] of [
      ['symlink file', 'leak.txt'],
      ['symlinked directory component', 'linked-dir/secret.txt'],
    ] as const) {
      const recorded = store.record({
        taskId: 'task-1',
        runId: 'run-1',
        type: 'diff',
        name,
        filePath,
      })
      if (!recorded.ok) throw new Error(recorded.error.message)
      expect(store.get({ artifactId: recorded.data.id })).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      })
    }
  })
})

describe('ArtifactStore.list (TASK-050)', () => {
  beforeEach(() => {
    for (const [name, type, runId, taskId] of [
      ['plan', 'plan', 'run-1', 'task-1'],
      ['impl', 'implementation', 'run-1', 'task-1'],
      ['review', 'review', 'run-2', 'task-2'],
    ] as const) {
      const recorded = store.record({ taskId, runId, type, name, content: name })
      if (!recorded.ok) throw new Error(recorded.error.message)
    }
  })

  it('filters by Task and optionally by type', () => {
    const byTask = store.list({ taskId: 'task-1' })
    expect(byTask.ok && byTask.data.map(({ name }) => name).sort()).toEqual(['impl', 'plan'])
    expect(store.list({ taskId: 'task-1', type: 'implementation' })).toMatchObject({
      ok: true,
      data: [{ name: 'impl' }],
    })
  })

  it('filters by Run and by Task+Run combined', () => {
    const byRun = store.list({ runId: 'run-1' })
    expect(byRun.ok && byRun.data.map(({ name }) => name).sort()).toEqual(['impl', 'plan'])
    expect(store.list({ runId: 'run-1', type: 'plan' })).toMatchObject({
      ok: true,
      data: [{ name: 'plan' }],
    })
    expect(store.list({ taskId: 'task-1', runId: 'run-2' })).toEqual({ ok: true, data: [] })
  })
})

describe('ArtifactStore.scanRun (TASK-050)', () => {
  it('registers unindexed files from the Run artifact directory and is idempotent', () => {
    writeRunFile('run-1', 'plan.md', '# Plan')
    writeRunFile('run-1', 'test-output.txt', 'ok')
    const recorded = store.record({
      taskId: 'task-1',
      runId: 'run-1',
      type: 'implementation',
      name: 'impl.md',
      filePath: writeRunFile('run-1', 'impl.md', 'done'),
    })
    if (!recorded.ok) throw new Error(recorded.error.message)

    const scanned = store.scanRun({ runId: 'run-1' })
    if (!scanned.ok) throw new Error(scanned.error.message)
    expect(scanned.data.map(({ name, type }) => `${name}:${type}`).sort()).toEqual([
      'impl.md:implementation',
      'plan.md:plan',
      'test-output.txt:test-result',
    ])
    for (const artifact of scanned.data) {
      expect(artifact.taskId).toBe('task-1')
      expect(artifact.runId).toBe('run-1')
    }

    const again = store.scanRun({ runId: 'run-1' })
    expect(again.ok && again.data.length).toBe(3)
  })

  it('rejects a missing Run and a Run without a Task', () => {
    expect(store.scanRun({ runId: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
    expect(store.scanRun({ runId: 'run-3' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
  })
})
