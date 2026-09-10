import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import type { IpcResult, WorkbenchEvents } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import {
  createAgentRunRepository,
  createCriteriaRepository,
  createReviewRepository,
  createTaskRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
} from '../db/repositories'
import { createEventBus } from '../events/event-bus'
import { createTeskraPaths } from '../paths'
import { createCommandRunner, type CommandRunner } from '../process/command-runner'
import { createWorkspaceRuntime } from '../workspace/runtime'
import { createMergePreflightService } from './merge-preflight-service'
import { createMergeService } from './merge-service'
import { createWorktreeManager } from './worktree-manager'

/**
 * TASK-075 — Worktree Safety Reference Tests.
 *
 * Each `it` pins one safety invariant from docs/teskra-tasks.md §TASK-075 as an
 * end-to-end behavior test against a real temporary git repository and an
 * in-memory SQLite database. Overlap with the per-service suites (TASK-043/044/
 * 045/046/047) is deliberate: this file is the single place that must keep
 * holding when any of those modules are refactored.
 */

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface Fixture {
  readonly merge: ReturnType<typeof createMergeService>
  readonly manager: ReturnType<typeof createWorktreeManager>
  readonly worktrees: ReturnType<typeof createWorktreeRepository>
  readonly tasks: ReturnType<typeof createTaskRepository>
  readonly runs: ReturnType<typeof createAgentRunRepository>
  readonly commands: CommandRunner
  readonly repoDir: string
  readonly dataRoot: string
}

/** Real git repository + in-memory SQLite + native-posix runtime (WSL dev host). */
async function setup(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-safety-'))
  directories.push(directory)
  const repoDir = join(directory, 'repo')
  const dataRoot = join(directory, 'data-root')
  mkdirSync(repoDir)
  const commands = createCommandRunner({ hostPlatform: 'linux' })
  const git = async (...args: string[]) => {
    const result = await commands.run({
      command: 'git',
      args,
      cwd: repoDir,
      timeoutMs: 15_000,
    })
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
  const tasks = createTaskRepository(database)
  const runs = createAgentRunRepository(database)
  const criteria = createCriteriaRepository(database)
  const reviews = createReviewRepository(database)
  const workspace = workspaces.create({
    id: 'workspace-1',
    name: 'Safety fixture',
    runtime: { kind: 'wsl', distro: 'Ubuntu' },
    path: repoDir,
  })
  if (!workspace.ok) throw new Error(workspace.error.message)

  const paths = createTeskraPaths({ TESKRA_HOME: dataRoot })
  const resolveRuntime = (candidate: typeof workspace.data) =>
    createWorkspaceRuntime(candidate.runtime, { hostPlatform: 'linux', paths })
  const events = createEventBus<WorkbenchEvents>()
  const manager = createWorktreeManager({ commands, workspaces, worktrees, events, resolveRuntime })
  const preflight = createMergePreflightService({
    commands,
    workspaces,
    worktrees,
    runs,
    criteria,
    reviews,
    resolveRuntime,
  })
  const merge = createMergeService({
    commands,
    workspaces,
    worktrees,
    runs,
    tasks,
    events,
    preflight,
    resolveRuntime,
  })
  return { merge, manager, worktrees, tasks, runs, commands, repoDir, dataRoot }
}

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

function requireRecord<T>(result: IpcResult<T | null>): T {
  const data = requireOk(result)
  if (data === null) throw new Error('expected a record, got null')
  return data
}

async function gitAt(fixture: Fixture, cwd: string, ...args: string[]) {
  const result = await fixture.commands.run({ command: 'git', args, cwd, timeoutMs: 15_000 })
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

async function createWorktree(fixture: Fixture, runId: string) {
  return requireOk(
    await fixture.manager.create({ workspaceId: 'workspace-1', runId, baseBranch: 'main' }),
  )
}

async function commitAll(fixture: Fixture, cwd: string, message: string) {
  expect((await gitAt(fixture, cwd, 'add', '--all')).exitCode).toBe(0)
  expect((await gitAt(fixture, cwd, 'commit', '--message', message)).exitCode).toBe(0)
}

describe('Worktree safety reference tests (TASK-075)', () => {
  it('dirty main blocks merge', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    writeFileSync(join(worktree.path, 'feature.txt'), 'agent output\n')
    await commitAll(fixture, worktree.path, 'agent: add feature')

    // The user has uncommitted work in the main checkout.
    writeFileSync(join(fixture.repoDir, 'scratch.txt'), 'dirty\n')
    const mainHead = (await gitAt(fixture, fixture.repoDir, 'rev-parse', 'HEAD')).stdout

    const result = await fixture.merge.merge({ worktreeId: worktree.id })
    expect(result).toMatchObject({ ok: false, error: { code: 'MERGE_BLOCKED' } })

    // Nothing happened: main HEAD and working tree untouched, no merge state,
    // worktree record still ready, agent work intact.
    expect((await gitAt(fixture, fixture.repoDir, 'rev-parse', 'HEAD')).stdout).toBe(mainHead)
    expect(existsSync(join(fixture.repoDir, 'feature.txt'))).toBe(false)
    const mainMergeHead = await gitAt(
      fixture,
      fixture.repoDir,
      'rev-parse',
      '--verify',
      'MERGE_HEAD',
    )
    expect(mainMergeHead.exitCode).not.toBe(0)
    expect(requireRecord(fixture.worktrees.getById(worktree.id)).state).toBe('ready')
    expect(readFileSync(join(worktree.path, 'feature.txt'), 'utf8')).toBe('agent output\n')
  })

  it('unmerged branch survives cleanup', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    writeFileSync(join(worktree.path, 'agent-work.txt'), 'unmerged work\n')
    await commitAll(fixture, worktree.path, 'agent: unmerged work')

    // Sanity: the branch really is unmerged before cleanup.
    const ancestor = await gitAt(
      fixture,
      fixture.repoDir,
      'merge-base',
      '--is-ancestor',
      worktree.branch,
      'main',
    )
    expect(ancestor.exitCode).not.toBe(0)

    const report = requireOk(await fixture.manager.cleanup({ workspaceId: 'workspace-1' }))
    expect(report.prunedRecordIds).toEqual([])
    expect(report.removedDirectoryIds).toEqual([])
    expect(report.skippedIds).toEqual([worktree.id])

    // The branch and its commit survive: cleanup never deletes agent work.
    const branches = await gitAt(fixture, fixture.repoDir, 'branch', '--format=%(refname)')
    expect(branches.stdout).toContain(`refs/heads/${worktree.branch}`)
    const log = await gitAt(fixture, fixture.repoDir, 'log', '--format=%s', worktree.branch)
    expect(log.stdout).toContain('agent: unmerged work')
    const stillUnmerged = await gitAt(
      fixture,
      fixture.repoDir,
      'merge-base',
      '--is-ancestor',
      worktree.branch,
      'main',
    )
    expect(stillUnmerged.exitCode).not.toBe(0)

    // The worktree itself is untouched and still tracked as ready.
    expect(readFileSync(join(worktree.path, 'agent-work.txt'), 'utf8')).toBe('unmerged work\n')
    expect(requireRecord(fixture.worktrees.getById(worktree.id)).state).toBe('ready')
  })

  it('merge conflict preserves worktree', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    requireOk(
      fixture.tasks.create({ id: 'task-1', workspaceId: 'workspace-1', title: 'Conflict task' }),
    )
    requireOk(
      fixture.runs.create({
        id: 'run-1',
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        agentType: 'fake-agent',
        executionMode: 'orchestrated',
        runDir: join(fixture.repoDir, '.run'),
        worktreeId: worktree.id,
      }),
    )

    // Both sides rewrite the same line; base moved ahead (force overrides the
    // overridable BASE_BRANCH_MISMATCH blocker).
    writeFileSync(join(worktree.path, 'README.md'), 'agent edit\n')
    await commitAll(fixture, worktree.path, 'agent: edit readme')
    writeFileSync(join(fixture.repoDir, 'README.md'), 'main edit\n')
    await commitAll(fixture, fixture.repoDir, 'feat: edit readme on main')

    const result = requireOk(await fixture.merge.merge({ worktreeId: worktree.id, force: true }))
    expect(result.outcome).toBe('conflict')
    expect(result.conflicts).toEqual(['README.md'])

    // The conflict scene is preserved for the user: worktree directory, branch,
    // MERGE_HEAD and the conflicted file with markers all survive.
    expect(existsSync(worktree.path)).toBe(true)
    const branches = await gitAt(fixture, fixture.repoDir, 'branch', '--list', worktree.branch)
    expect(branches.stdout).toContain(worktree.branch)
    const mergeHead = await gitAt(fixture, worktree.path, 'rev-parse', '--verify', 'MERGE_HEAD')
    expect(mergeHead.exitCode).toBe(0)
    expect(readFileSync(join(worktree.path, 'README.md'), 'utf8')).toContain('<<<<<<<')

    // The main checkout was never touched.
    const mainMergeHead = await gitAt(
      fixture,
      fixture.repoDir,
      'rev-parse',
      '--verify',
      'MERGE_HEAD',
    )
    expect(mainMergeHead.exitCode).not.toBe(0)
    expect(readFileSync(join(fixture.repoDir, 'README.md'), 'utf8')).toBe('main edit\n')

    // The record is parked in the conflict state, not torn down.
    expect(requireRecord(fixture.worktrees.getById(worktree.id)).state).toBe('conflict')
  })

  it('missing worktree becomes broken', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')

    // The directory is deleted out of band (crash, user, OS cleanup).
    rmSync(worktree.path, { recursive: true, force: true })

    const validated = requireOk(await fixture.manager.validate({ worktreeId: worktree.id }))
    expect(validated.state).toBe('missing')
    // The detected state is persisted, not just reported.
    expect(requireRecord(fixture.worktrees.getById(worktree.id)).state).toBe('missing')
  })

  it('cleanup is idempotent', async () => {
    const fixture = await setup()

    // One active worktree cleanup must never touch, plus three safe leftovers:
    // a missing record, a merged record with its directory still on disk, and a
    // discarded record with its directory still on disk.
    const active = await createWorktree(fixture, 'run-active')
    writeFileSync(join(active.path, 'dirty.txt'), 'uncommitted\n')

    const missing = await createWorktree(fixture, 'run-missing')
    rmSync(missing.path, { recursive: true, force: true })
    requireOk(await fixture.manager.validate({ worktreeId: missing.id }))

    const merged = await createWorktree(fixture, 'run-merged')
    requireOk(fixture.worktrees.updateState(merged.id, 'merged'))
    const discarded = await createWorktree(fixture, 'run-discarded')
    requireOk(fixture.worktrees.updateState(discarded.id, 'discarded'))

    const first = requireOk(await fixture.manager.cleanup({ workspaceId: 'workspace-1' }))
    expect(first.prunedRecordIds).toEqual([missing.id])
    expect(first.removedDirectoryIds.sort()).toEqual([merged.id, discarded.id].sort())
    expect(first.skippedIds).toEqual([active.id])
    expect(existsSync(merged.path)).toBe(false)
    expect(existsSync(discarded.path)).toBe(false)

    // Second run: nothing left to do, and the active worktree is still intact.
    const second = requireOk(await fixture.manager.cleanup({ workspaceId: 'workspace-1' }))
    expect(second.prunedRecordIds).toEqual([])
    expect(second.removedDirectoryIds).toEqual([])
    expect(second.skippedIds).toEqual([active.id])
    expect(readFileSync(join(active.path, 'dirty.txt'), 'utf8')).toBe('uncommitted\n')
    expect(requireRecord(fixture.worktrees.getById(active.id)).state).toBe('ready')
  })
})
