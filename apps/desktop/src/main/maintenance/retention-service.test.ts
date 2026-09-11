import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import type { IpcResult, RetentionConfig, WorkbenchEvents } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import {
  createAgentRunRepository,
  createHandoffRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
} from '../db/repositories'
import { createEventBus } from '../events/event-bus'
import { createWorktreeManager } from '../git/worktree-manager'
import { createTeskraPaths } from '../paths'
import { createCommandRunner, type CommandRunner } from '../process/command-runner'
import { createWorkspaceRuntime } from '../workspace/runtime'
import { createRetentionService, type RetentionService } from './retention-service'

/**
 * TASK-069 — RetentionService tests.
 *
 * Real temporary git repository + tmpdir TESKRA_HOME + in-memory SQLite,
 * mirroring the TASK-075 safety fixture. The pinned behaviors are the
 * TASK-069 acceptance criteria: dry-run, unmerged branches never deleted,
 * cancellable GC, per-deletion audit, and idempotency.
 */

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const DAY_MS = 24 * 60 * 60 * 1000
const WORKSPACE_ID = 'workspace-1'

interface Fixture {
  readonly service: RetentionService
  readonly worktrees: ReturnType<typeof createWorktreeRepository>
  readonly runs: ReturnType<typeof createAgentRunRepository>
  readonly handoffs: ReturnType<typeof createHandoffRepository>
  readonly manager: ReturnType<typeof createWorktreeManager>
  readonly commands: CommandRunner
  readonly paths: ReturnType<typeof createTeskraPaths>
  readonly repoDir: string
  readonly dataRoot: string
  readonly setPolicy: (policy: RetentionConfig) => void
  readonly setNow: (now: Date) => void
  readonly setOnItemStart: (hook: ((item: unknown) => void) | undefined) => void
}

async function setup(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-retention-'))
  directories.push(directory)
  const repoDir = join(directory, 'repo')
  const dataRoot = join(directory, 'data-root')
  mkdirSync(repoDir)
  const commands = createCommandRunner({ hostPlatform: 'linux' })
  const git = async (...args: string[]) => {
    const result = await commands.run({ command: 'git', args, cwd: repoDir, timeoutMs: 15_000 })
    if (!result.ok || result.data.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.ok ? result.data.stderr : 'ipc'}`)
    }
    return result.data.stdout
  }
  await git('init', '--initial-branch=main')
  await git('config', 'user.name', 'Teskra Test')
  await git('config', 'user.email', 'teskra@example.invalid')
  writeFileSync(join(repoDir, 'README.md'), 'fixture\n')
  await git('add', '--all')
  await git('commit', '--message', 'feat: initial')

  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(database)
  if (!migrated.ok) throw new Error(migrated.error.message)
  databases.push(database)
  const workspaces = createWorkspaceRepository(database)
  const worktrees = createWorktreeRepository(database)
  const runs = createAgentRunRepository(database)
  const handoffs = createHandoffRepository(database)
  const workspace = workspaces.create({
    id: WORKSPACE_ID,
    name: 'Retention fixture',
    runtime: { kind: 'wsl', distro: 'Ubuntu' },
    path: repoDir,
  })
  if (!workspace.ok) throw new Error(workspace.error.message)

  const paths = createTeskraPaths({ TESKRA_HOME: dataRoot })
  const resolveRuntime = (candidate: typeof workspace.data) =>
    createWorkspaceRuntime(candidate.runtime, { hostPlatform: 'linux', paths })
  const events = createEventBus<WorkbenchEvents>()
  const manager = createWorktreeManager({ commands, workspaces, worktrees, events, resolveRuntime })

  let policy: RetentionConfig = {
    mergedWorktreeDays: 1,
    completedRunLogsDays: 30,
    discardedRunDays: 30,
  }
  let currentDate = new Date('2026-09-11T00:00:00.000Z')
  let onItemStart: ((item: unknown) => void) | undefined
  const service = createRetentionService({
    commands,
    workspaces,
    worktrees,
    runs,
    handoffs,
    events,
    paths,
    resolveRuntime,
    resolvePolicy: () => ({ ok: true, data: policy }),
    now: () => currentDate,
    onItemStart: (item) => onItemStart?.(item),
  })

  return {
    service,
    worktrees,
    runs,
    handoffs,
    manager,
    commands,
    paths,
    repoDir,
    dataRoot,
    setPolicy: (next) => {
      policy = next
    },
    setNow: (next) => {
      currentDate = next
    },
    setOnItemStart: (hook) => {
      onItemStart = hook
    },
  }
}

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

function daysAgo(days: number, base?: Date): string {
  const now = base ?? new Date('2026-09-11T00:00:00.000Z')
  return new Date(now.getTime() - days * DAY_MS).toISOString()
}

async function gitAt(fixture: Fixture, cwd: string, ...args: string[]) {
  const result = await fixture.commands.run({ command: 'git', args, cwd, timeoutMs: 15_000 })
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

async function branchExists(fixture: Fixture, branch: string): Promise<boolean> {
  const result = await gitAt(fixture, fixture.repoDir, 'rev-parse', '--verify', '--quiet', branch)
  return result.exitCode === 0
}

/** Creates a real worktree + branch with one commit ahead of main. */
async function createWorktreeWithCommit(fixture: Fixture, runId: string, file: string) {
  const created = requireOk(
    await fixture.manager.create({ workspaceId: WORKSPACE_ID, runId, baseBranch: 'main' }),
  )
  writeFileSync(join(created.path, file), `${file}\n`)
  await gitAt(fixture, created.path, 'add', '--all')
  await gitAt(fixture, created.path, 'commit', '--message', `feat: ${file}`)
  return created
}

/** Merges the worktree branch into main (fast-forward) and marks it merged long ago. */
async function mergeIntoMain(
  fixture: Fixture,
  worktree: { id: string; branch: string },
  mergedDaysAgo: number,
) {
  await gitAt(fixture, fixture.repoDir, 'merge', worktree.branch)
  const mergedAt = daysAgo(mergedDaysAgo)
  const updated = fixture.worktrees.update(
    worktree.id,
    { state: 'merged', mergedAt },
    new Date().toISOString(),
  )
  if (!updated.ok) throw new Error(updated.error.message)
}

/** A terminal run record with a populated run directory under TESKRA_HOME. */
function createRunRecord(
  fixture: Fixture,
  runId: string,
  options: { status?: 'completed' | 'failed' | 'cancelled'; finishedDaysAgo?: number } = {},
) {
  const runDir = requireOk(fixture.paths.runDir(runId))
  const files = requireOk(fixture.paths.runFiles(runId))
  writeFileSync(files.events, '{"seq":1}\n')
  writeFileSync(files.terminal, 'terminal-bytes\n')
  writeFileSync(files.manifest, '{}\n')
  writeFileSync(files.handoff, '{}\n')
  const finishedAt =
    options.finishedDaysAgo === undefined ? undefined : daysAgo(options.finishedDaysAgo)
  const created = fixture.runs.create({
    id: runId,
    workspaceId: WORKSPACE_ID,
    agentType: 'fake-agent',
    executionMode: 'attended',
    runDir,
    status: options.status ?? 'completed',
    ...(finishedAt === undefined ? {} : { startedAt: finishedAt }),
  })
  if (!created.ok) throw new Error(created.error.message)
  if (finishedAt !== undefined) {
    const updated = fixture.runs.update(
      runId,
      { finishedAt },
      daysAgo(options.finishedDaysAgo ?? 0),
    )
    if (!updated.ok) throw new Error(updated.error.message)
  }
  return { runDir, files }
}

describe('RetentionService (TASK-069)', () => {
  it('plan() is a dry-run: it lists candidates and changes nothing', async () => {
    const fixture = await setup()
    const worktree = await createWorktreeWithCommit(fixture, 'run-1', 'a.txt')
    await mergeIntoMain(fixture, worktree, 10)
    const run = createRunRecord(fixture, 'run-1', { finishedDaysAgo: 40 })

    const plan = requireOk(await fixture.service.plan())
    expect(plan.items.map((item) => item.kind).sort()).toEqual(['merged-worktree', 'run-logs'])
    expect(plan.policy).toEqual({
      mergedWorktreeDays: 1,
      completedRunLogsDays: 30,
      discardedRunDays: 30,
    })
    for (const item of plan.items) {
      expect(item.reason.length).toBeGreaterThan(0)
      expect(item.ageDays).toBeGreaterThan(0)
    }

    // Nothing moved: directory, branch, record, and log files all survive.
    expect(existsSync(worktree.path)).toBe(true)
    expect(await branchExists(fixture, worktree.branch)).toBe(true)
    expect(requireOk(fixture.worktrees.getById(worktree.id))).not.toBeNull()
    expect(existsSync(run.files.events)).toBe(true)
    expect(existsSync(run.files.terminal)).toBe(true)

    const report = requireOk(await fixture.service.run({ dryRun: true }))
    expect(report.dryRun).toBe(true)
    expect(report.cancelled).toBe(false)
    expect(report.entries).toHaveLength(2)
    expect(report.entries.every((entry) => entry.action === 'skipped')).toBe(true)
    expect(existsSync(worktree.path)).toBe(true)
    expect(await branchExists(fixture, worktree.branch)).toBe(true)
    expect(existsSync(run.files.events)).toBe(true)
  })

  it('collects merged worktrees (directory + record + branch) but never an unmerged branch', async () => {
    const fixture = await setup()
    const mergedWorktree = await createWorktreeWithCommit(fixture, 'run-1', 'merged.txt')
    await mergeIntoMain(fixture, mergedWorktree, 5)

    // A worktree whose DB record claims "merged" while git disagrees: the
    // branch holds commits main does not. Retention must leave it alone.
    const stale = await createWorktreeWithCommit(fixture, 'run-2', 'unmerged.txt')
    const staleMergedAt = daysAgo(5)
    requireOk(
      fixture.worktrees.update(
        stale.id,
        { state: 'merged', mergedAt: staleMergedAt },
        new Date().toISOString(),
      ),
    )
    // Rewrite history so the branch is NOT an ancestor of main anymore (and
    // it never was merged — the DB record is simply stale/wrong).
    await gitAt(fixture, stale.path, 'commit', '--amend', '--message', 'feat: rewritten')

    const plan = requireOk(await fixture.service.plan())
    expect(plan.items.map((item) => item.worktreeId)).toEqual([mergedWorktree.id])

    const report = requireOk(await fixture.service.run())
    const entry = report.entries.find((e) => e.item.worktreeId === mergedWorktree.id)
    expect(entry?.action).toBe('deleted')

    expect(existsSync(mergedWorktree.path)).toBe(false)
    expect(await branchExists(fixture, mergedWorktree.branch)).toBe(false)
    expect(requireOk(fixture.worktrees.getById(mergedWorktree.id))).toBeNull()

    // The unmerged branch and its worktree survive untouched.
    expect(existsSync(stale.path)).toBe(true)
    expect(await branchExists(fixture, stale.branch)).toBe(true)
    expect(requireOk(fixture.worktrees.getById(stale.id))).not.toBeNull()
  })

  it('collects volatile run logs of old terminal runs, keeping manifest and handoff', async () => {
    const fixture = await setup()
    const old = createRunRecord(fixture, 'run-old', { finishedDaysAgo: 45 })
    const fresh = createRunRecord(fixture, 'run-fresh', { finishedDaysAgo: 2 })
    const running = createRunRecord(fixture, 'run-live', {})
    requireOk(fixture.runs.update('run-live', { status: 'running' }, new Date().toISOString()))

    const report = requireOk(await fixture.service.run())
    const kinds = report.entries.map((entry) => [entry.item.runId, entry.action])
    expect(kinds).toEqual([['run-old', 'deleted']])

    expect(existsSync(old.files.events)).toBe(false)
    expect(existsSync(old.files.terminal)).toBe(false)
    expect(existsSync(old.files.manifest)).toBe(true)
    expect(existsSync(old.files.handoff)).toBe(true)
    expect(requireOk(fixture.runs.getById('run-old'))).not.toBeNull()

    expect(existsSync(fresh.files.events)).toBe(true)
    expect(existsSync(running.files.events)).toBe(true)
  })

  it('cleans discarded runs: directory + discarded worktree + record, branch kept, handoff retained', async () => {
    const fixture = await setup()
    // Run A: discarded worktree, no handoff → everything collected, branch kept.
    const worktreeA = await createWorktreeWithCommit(fixture, 'run-a', 'a.txt')
    createRunRecord(fixture, 'run-a', { status: 'cancelled', finishedDaysAgo: 40 })
    requireOk(await fixture.manager.discard({ worktreeId: worktreeA.id, confirm: true }))
    requireOk(
      fixture.worktrees.update(
        worktreeA.id,
        { discardedAt: daysAgo(40) },
        new Date().toISOString(),
      ),
    )

    // Run B: discarded worktree WITH a handoff DB record → directory goes,
    // the agent_runs row stays (post-hoc audit, ADR-0002).
    const worktreeB = await createWorktreeWithCommit(fixture, 'run-b', 'b.txt')
    createRunRecord(fixture, 'run-b', { status: 'failed', finishedDaysAgo: 40 })
    requireOk(await fixture.manager.discard({ worktreeId: worktreeB.id, confirm: true }))
    requireOk(
      fixture.worktrees.update(
        worktreeB.id,
        { discardedAt: daysAgo(40) },
        new Date().toISOString(),
      ),
    )
    const handoff = fixture.handoffs.save({
      id: 'handoff-b',
      runId: 'run-b',
      type: 'implementation',
      parseStatus: 'missing',
    })
    if (!handoff.ok) throw new Error(handoff.error.message)

    const plan = requireOk(await fixture.service.plan())
    expect(
      plan.items
        .filter((item) => item.kind === 'discarded-run')
        .map((item) => item.runId)
        .sort(),
    ).toEqual(['run-a', 'run-b'])

    const report = requireOk(await fixture.service.run())
    const discardedEntries = report.entries.filter((entry) => entry.item.kind === 'discarded-run')
    const entryA = discardedEntries.find((entry) => entry.item.runId === 'run-a')
    const entryB = discardedEntries.find((entry) => entry.item.runId === 'run-b')
    expect(entryA?.action).toBe('deleted')
    expect(entryA?.detail).toContain('run record')
    expect(entryB?.action).toBe('deleted')
    expect(entryB?.detail).toContain('handoff retained')

    expect(requireOk(fixture.runs.getById('run-a'))).toBeNull()
    expect(requireOk(fixture.worktrees.getById(worktreeA.id))).toBeNull()
    // Discarded branches are never deleted by retention.
    expect(await branchExists(fixture, worktreeA.branch)).toBe(true)
    expect(await branchExists(fixture, worktreeB.branch)).toBe(true)

    expect(requireOk(fixture.runs.getById('run-b'))).not.toBeNull()
    expect(requireOk(fixture.handoffs.getByRunId('run-b'))).not.toBeNull()
    expect(existsSync(join(fixture.dataRoot, 'runs', 'run-b'))).toBe(false)
  })

  it('is cancellable: items after the abort stay untouched', async () => {
    const fixture = await setup()
    const runs = [
      createRunRecord(fixture, 'run-1', { finishedDaysAgo: 40 }),
      createRunRecord(fixture, 'run-2', { finishedDaysAgo: 40 }),
      createRunRecord(fixture, 'run-3', { finishedDaysAgo: 40 }),
    ]

    const controller = new AbortController()
    let seen = 0
    fixture.setOnItemStart(() => {
      seen += 1
      if (seen === 2) controller.abort()
    })

    const report = requireOk(await fixture.service.run({}, controller.signal))
    expect(report.cancelled).toBe(true)
    // Entries follow processing order: first item done, the rest cancelled.
    expect(report.entries.map((entry) => entry.action)).toEqual(['deleted', 'skipped', 'skipped'])
    expect(report.entries[1]?.detail).toContain('cancelled')
    expect(report.entries[2]?.detail).toContain('cancelled')

    // Exactly one run directory lost its logs; the other two are untouched.
    const deleted = runs.filter((run) => !existsSync(run.files.events))
    const kept = runs.filter((run) => existsSync(run.files.events))
    expect(deleted).toHaveLength(1)
    expect(kept).toHaveLength(2)

    // cancel() reports whether a run was in flight.
    expect(requireOk(fixture.service.cancel())).toBe(false)
  })

  it('audits every deletion (what, why, when) and is idempotent', async () => {
    const fixture = await setup()
    const worktree = await createWorktreeWithCommit(fixture, 'run-1', 'a.txt')
    await mergeIntoMain(fixture, worktree, 10)
    createRunRecord(fixture, 'run-1', { finishedDaysAgo: 40 })

    const report = requireOk(await fixture.service.run())
    expect(report.entries.length).toBeGreaterThan(0)
    for (const entry of report.entries) {
      expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
      expect(entry.item.reason.length).toBeGreaterThan(0)
      expect(entry.detail?.length).toBeGreaterThan(0)
    }
    expect(report.entries.every((entry) => entry.action === 'deleted')).toBe(true)

    const secondPlan = requireOk(await fixture.service.plan())
    expect(secondPlan.items).toEqual([])
    const secondRun = requireOk(await fixture.service.run())
    expect(secondRun.entries).toEqual([])
  })

  it('respects per-call workspace scoping and retention thresholds', async () => {
    const fixture = await setup()
    const recent = createRunRecord(fixture, 'run-recent', { finishedDaysAgo: 10 })
    fixture.setPolicy({ mergedWorktreeDays: 1, completedRunLogsDays: 30, discardedRunDays: 30 })

    // Below the threshold → no candidates.
    expect(requireOk(await fixture.service.plan()).items).toEqual([])

    fixture.setPolicy({ mergedWorktreeDays: 1, completedRunLogsDays: 7, discardedRunDays: 30 })
    const plan = requireOk(await fixture.service.plan({ workspaceId: WORKSPACE_ID }))
    expect(plan.items.map((item) => item.runId)).toEqual(['run-recent'])
    expect(existsSync(recent.files.events)).toBe(true)

    const missing = await fixture.service.plan({ workspaceId: 'no-such-workspace' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('WORKSPACE_NOT_FOUND')
  })
})
