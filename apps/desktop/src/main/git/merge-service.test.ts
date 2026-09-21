import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
import { createDecisionRepository } from '../decisions/decision-repository'
import { createDecisionService, type DecisionService } from '../decisions/decision-service'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createTeskraPaths } from '../paths'
import { createCommandRunner, type CommandRunner } from '../process/command-runner'
import { createWorkspaceRuntime } from '../workspace/runtime'
import { createMergePreflightService } from './merge-preflight-service'
import { createMergeService } from './merge-service'
import { createWorktreeManager } from './worktree-manager'

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

interface EmittedEvent {
  readonly name: string
  readonly payload: unknown
}

interface Fixture {
  readonly service: ReturnType<typeof createMergeService>
  readonly manager: ReturnType<typeof createWorktreeManager>
  readonly worktrees: ReturnType<typeof createWorktreeRepository>
  readonly tasks: ReturnType<typeof createTaskRepository>
  readonly runs: ReturnType<typeof createAgentRunRepository>
  readonly commands: CommandRunner
  readonly events: EventBus<WorkbenchEvents>
  readonly decisions: DecisionService
  readonly emitted: EmittedEvent[]
  readonly repoDir: string
}

/** Real git repository + in-memory SQLite + native-posix runtime (WSL dev host). */
async function setup(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-merge-'))
  directories.push(directory)
  const repoDir = join(directory, 'repo')
  const dataRoot = join(directory, 'data-root')
  mkdirSync(repoDir)
  const commands = createCommandRunner()
  const git = async (...args: string[]) => {
    const result = await commands.run({
      command: 'git',
      args,
      cwd: repoDir,
      timeoutMs: 15_000,
    })
    if (!result.ok || result.data.exitCode !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed: ${
          result.ok
            ? `exit=${String(result.data.exitCode)} stderr=${JSON.stringify(result.data.stderr)} stdout=${JSON.stringify(result.data.stdout)}`
            : `${result.error.code}: ${result.error.message}`
        }`,
      )
    }
    return result.data.stdout
  }
  await git('init', '--initial-branch=main')
  await git('config', 'user.name', 'Teskra Test')
  await git('config', 'user.email', 'teskra@example.invalid')
  // Keep checkouts byte-identical on every host: Git for Windows defaults to
  // core.autocrlf=true, which would rewrite LF to CRLF on checkout.
  await git('config', 'core.autocrlf', 'false')
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
    name: 'Merge fixture',
    runtime: { kind: 'wsl', distro: 'Ubuntu' },
    path: repoDir,
  })
  if (!workspace.ok) throw new Error(workspace.error.message)

  const events = createEventBus<WorkbenchEvents>()
  const emitted: EmittedEvent[] = []
  events.subscribe('worktree.merge_conflict', (payload) =>
    emitted.push({ name: 'worktree.merge_conflict', payload }),
  )
  events.subscribe('worktree.merged', (payload) =>
    emitted.push({ name: 'worktree.merged', payload }),
  )
  events.subscribe('task.updated', (payload) => emitted.push({ name: 'task.updated', payload }))

  const paths = createTeskraPaths({ TESKRA_HOME: dataRoot })
  const resolveRuntime = (candidate: typeof workspace.data) =>
    createWorkspaceRuntime(candidate.runtime, { hostPlatform: 'linux', paths })
  const manager = createWorktreeManager({
    commands,
    workspaces,
    worktrees,
    events,
    resolveRuntime,
  })
  const preflight = createMergePreflightService({
    commands,
    workspaces,
    worktrees,
    runs,
    criteria,
    reviews,
    resolveRuntime,
  })
  // TASK-130: the real persisted inbox shares the fixture's connection + bus.
  const decisions = createDecisionService({
    decisions: createDecisionRepository(database),
    events,
  })
  const service = createMergeService({
    commands,
    workspaces,
    worktrees,
    runs,
    tasks,
    events,
    preflight,
    resolveRuntime,
    decisions,
  })
  return { service, manager, worktrees, tasks, runs, commands, events, decisions, emitted, repoDir }
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

/** Creates a real worktree (branch agent/<runId> based on main). */
async function createWorktree(fixture: Fixture, runId: string) {
  return requireOk(
    await fixture.manager.create({ workspaceId: 'workspace-1', runId, baseBranch: 'main' }),
  )
}

async function gitAt(fixture: Fixture, cwd: string, ...args: string[]) {
  const result = await fixture.commands.run({ command: 'git', args, cwd, timeoutMs: 15_000 })
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

async function commitAll(fixture: Fixture, cwd: string, message: string) {
  const added = await gitAt(fixture, cwd, 'add', '--all')
  expect(added.exitCode).toBe(0)
  const committed = await gitAt(fixture, cwd, 'commit', '--message', message)
  expect(committed.exitCode).toBe(0)
}

describe('MergeService (TASK-046)', () => {
  it('preserves the worktree, branch and diff when the merge conflicts', async () => {
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

    // Real conflict: both sides rewrite the same line; base moved ahead, so
    // the overridable BASE_BRANCH_MISMATCH blocker requires force.
    writeFileSync(join(worktree.path, 'README.md'), 'agent edit\n')
    await commitAll(fixture, worktree.path, 'agent: edit readme')
    writeFileSync(join(fixture.repoDir, 'README.md'), 'main edit\n')
    await commitAll(fixture, fixture.repoDir, 'feat: edit readme on main')

    const result = requireOk(await fixture.service.merge({ worktreeId: worktree.id, force: true }))
    expect(result.outcome).toBe('conflict')
    expect(result.conflicts).toEqual(['README.md'])
    expect(result.worktree.state).toBe('conflict')

    // Nothing was torn down: directory, branch, diff and merge state survive.
    expect(existsSync(worktree.path)).toBe(true)
    const branches = await gitAt(fixture, fixture.repoDir, 'branch', '--list', worktree.branch)
    expect(branches.stdout).toContain(worktree.branch)
    const mergeHead = await gitAt(fixture, worktree.path, 'rev-parse', '--verify', 'MERGE_HEAD')
    expect(mergeHead.exitCode).toBe(0)
    const diff = await gitAt(fixture, worktree.path, 'diff')
    expect(diff.stdout).toContain('<<<<<<<')
    expect(readFileSync(join(worktree.path, 'README.md'), 'utf8')).toContain('agent edit')

    // The main checkout was never touched: no merge state, still on main.
    const mainMergeHead = await gitAt(
      fixture,
      fixture.repoDir,
      'rev-parse',
      '--verify',
      'MERGE_HEAD',
    )
    expect(mainMergeHead.exitCode).not.toBe(0)
    expect(readFileSync(join(fixture.repoDir, 'README.md'), 'utf8')).toBe('main edit\n')

    // DB markers: worktree conflict, Run error_json, Task needs_review.
    expect(requireRecord(fixture.worktrees.getById(worktree.id)).state).toBe('conflict')
    const run = requireRecord(fixture.runs.getById('run-1'))
    expect(run?.error).toMatchObject({ code: 'MERGE_CONFLICT' })
    expect(requireOk(fixture.tasks.getById('task-1'))?.status).toBe('needs_review')

    // Events: conflict + task update were emitted.
    expect(fixture.emitted.map((event) => event.name)).toEqual(
      expect.arrayContaining(['worktree.merge_conflict', 'task.updated']),
    )
    const conflictEvent = fixture.emitted.find((event) => event.name === 'worktree.merge_conflict')
    expect(conflictEvent?.payload).toMatchObject({
      worktreeId: worktree.id,
      runId: 'run-1',
      branch: worktree.branch,
      baseBranch: 'main',
      conflicts: ['README.md'],
    })
  })

  it('merges a clean agent branch into the base and keeps the branch', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    writeFileSync(join(worktree.path, 'feature.txt'), 'agent output\n')
    await commitAll(fixture, worktree.path, 'agent: add feature')

    const result = requireOk(await fixture.service.merge({ worktreeId: worktree.id }))
    expect(result.outcome).toBe('merged')
    expect(result.conflicts).toBeUndefined()

    // The base branch (checked out in the main repo) now contains the change.
    expect(readFileSync(join(fixture.repoDir, 'feature.txt'), 'utf8')).toBe('agent output\n')
    const ancestor = await gitAt(
      fixture,
      fixture.repoDir,
      'merge-base',
      '--is-ancestor',
      worktree.branch,
      'main',
    )
    expect(ancestor.exitCode).toBe(0)

    // Worktree marked merged; the branch is deliberately kept (TASK-047
    // owns cleanup), and the worktree directory stays put.
    const record = requireRecord(fixture.worktrees.getById(worktree.id))
    expect(record.state).toBe('merged')
    expect(record.mergedAt).toBeDefined()
    const branches = await gitAt(fixture, fixture.repoDir, 'branch', '--list', worktree.branch)
    expect(branches.stdout).toContain(worktree.branch)
    expect(existsSync(worktree.path)).toBe(true)
    expect(fixture.emitted.map((event) => event.name)).toContain('worktree.merged')
  })

  it('advances the base branch without touching a checkout on another branch', async () => {
    const fixture = await setup()
    // Main checkout sits on an unrelated branch while the merge runs.
    const side = await gitAt(fixture, fixture.repoDir, 'checkout', '-b', 'side')
    expect(side.exitCode).toBe(0)
    const worktree = await createWorktree(fixture, 'run-1')
    writeFileSync(join(worktree.path, 'feature.txt'), 'agent output\n')
    await commitAll(fixture, worktree.path, 'agent: add feature')

    const result = requireOk(await fixture.service.merge({ worktreeId: worktree.id }))
    expect(result.outcome).toBe('merged')

    // main moved to include the agent change; the side checkout is untouched.
    const mergedFile = await gitAt(fixture, fixture.repoDir, 'show', 'main:feature.txt')
    expect(mergedFile.exitCode).toBe(0)
    expect(mergedFile.stdout).toBe('agent output\n')
    expect(existsSync(join(fixture.repoDir, 'feature.txt'))).toBe(false)
    const current = await gitAt(fixture, fixture.repoDir, 'branch', '--show-current')
    expect(current.stdout.trim()).toBe('side')
  })

  it('refuses a blocked merge and leaves git and database state untouched', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    writeFileSync(join(worktree.path, 'feature.txt'), 'agent output\n')
    await commitAll(fixture, worktree.path, 'agent: add feature')
    writeFileSync(join(fixture.repoDir, 'scratch.txt'), 'dirty\n')

    const mainHead = (await gitAt(fixture, fixture.repoDir, 'rev-parse', 'HEAD')).stdout
    const result = await fixture.service.merge({ worktreeId: worktree.id })
    expect(result).toMatchObject({ ok: false, error: { code: 'MERGE_BLOCKED' } })

    // Nothing happened: HEAD, working tree, and the worktree record unchanged.
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
    expect(fixture.emitted).toEqual([])
  })

  it('force only overrides overridable blockers, never hard ones', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    // BRANCH_MISSING is overridable: false — force must not bypass it.
    const deleted = await gitAt(
      fixture,
      fixture.repoDir,
      'update-ref',
      '-d',
      `refs/heads/${worktree.branch}`,
    )
    expect(deleted.exitCode).toBe(0)

    const result = await fixture.service.merge({ worktreeId: worktree.id, force: true })
    expect(result).toMatchObject({ ok: false, error: { code: 'MERGE_BLOCKED' } })
    expect(requireRecord(fixture.worktrees.getById(worktree.id)).state).toBe('ready')
  })

  it('completes a conflicted merge after the user resolves it in the worktree', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    writeFileSync(join(worktree.path, 'README.md'), 'agent edit\n')
    await commitAll(fixture, worktree.path, 'agent: edit readme')
    writeFileSync(join(fixture.repoDir, 'README.md'), 'main edit\n')
    await commitAll(fixture, fixture.repoDir, 'feat: edit readme on main')

    const conflicted = requireOk(
      await fixture.service.merge({ worktreeId: worktree.id, force: true }),
    )
    expect(conflicted.outcome).toBe('conflict')

    // The user resolves the preserved scene and commits inside the worktree.
    writeFileSync(join(worktree.path, 'README.md'), 'resolved\n')
    await commitAll(fixture, worktree.path, 'agent: resolve merge conflict')

    const retried = requireOk(await fixture.service.merge({ worktreeId: worktree.id }))
    expect(retried.outcome).toBe('merged')
    expect(readFileSync(join(fixture.repoDir, 'README.md'), 'utf8')).toBe('resolved\n')
    expect(requireRecord(fixture.worktrees.getById(worktree.id)).state).toBe('merged')
  })

  it('fails closed for unknown worktrees', async () => {
    const fixture = await setup()
    const result = await fixture.service.merge({ worktreeId: 'nope' })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('TASK-130: opens a merge_blocked decision for overridable-only blockers; force_merge re-runs the merge', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    // pending_decisions.run_id REFERENCES agent_runs — the linked run row must exist.
    requireOk(
      fixture.runs.create({
        id: 'run-1',
        workspaceId: 'workspace-1',
        agentType: 'fake-agent',
        executionMode: 'orchestrated',
        runDir: join(fixture.repoDir, '.run'),
        worktreeId: worktree.id,
      }),
    )
    writeFileSync(join(worktree.path, 'feature.txt'), 'agent output\n')
    await commitAll(fixture, worktree.path, 'agent: add feature')
    // MAIN_WORKSPACE_DIRTY (overridable) is the only blocker.
    writeFileSync(join(fixture.repoDir, 'scratch.txt'), 'dirty\n')

    const blocked = await fixture.service.merge({ worktreeId: worktree.id })
    expect(blocked).toMatchObject({ ok: false, error: { code: 'MERGE_BLOCKED' } })
    expect(requireRecord(fixture.worktrees.getById(worktree.id)).state).toBe('ready')

    const open = requireOk(fixture.decisions.list({ kind: 'merge_blocked', status: 'open' }))
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({
      kind: 'merge_blocked',
      severity: 'warning',
      workspaceId: 'workspace-1',
      worktreeId: worktree.id,
      dedupeKey: `merge_blocked:${worktree.id}`,
      options: [
        { id: 'force_merge', label: 'Force merge', danger: true },
        { id: 'cancel', label: 'Cancel' },
      ],
    })
    const decision = open[0]
    if (decision === undefined) throw new Error('unreachable')
    if (decision.detail.kind !== 'merge_blocked') throw new Error('unreachable')
    expect(decision.detail.blockers.map((blocker) => blocker.code)).toEqual([
      'MAIN_WORKSPACE_DIRTY',
    ])

    // A repeated blocked attempt reuses the same open row (dedupeKey).
    await fixture.service.merge({ worktreeId: worktree.id })
    expect(
      requireOk(fixture.decisions.list({ kind: 'merge_blocked', status: 'open' })),
    ).toHaveLength(1)

    // force_merge resolves into merge({ force: true }) and the merge lands.
    const resolved = fixture.decisions.resolve(decision.id, 'force_merge', 'user')
    expect(resolved.ok).toBe(true)
    await vi.waitFor(() => {
      expect(requireRecord(fixture.worktrees.getById(worktree.id)).state).toBe('merged')
    })
    expect(readFileSync(join(fixture.repoDir, 'feature.txt'), 'utf8')).toBe('agent output\n')
  })

  it('TASK-130: cancel leaves the blocked merge untouched', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    requireOk(
      fixture.runs.create({
        id: 'run-1',
        workspaceId: 'workspace-1',
        agentType: 'fake-agent',
        executionMode: 'orchestrated',
        runDir: join(fixture.repoDir, '.run'),
        worktreeId: worktree.id,
      }),
    )
    writeFileSync(join(worktree.path, 'feature.txt'), 'agent output\n')
    await commitAll(fixture, worktree.path, 'agent: add feature')
    writeFileSync(join(fixture.repoDir, 'scratch.txt'), 'dirty\n')

    await fixture.service.merge({ worktreeId: worktree.id })
    const open = requireOk(fixture.decisions.list({ kind: 'merge_blocked', status: 'open' }))
    const decision = open[0]
    if (decision === undefined) throw new Error('expected an open merge_blocked decision')

    const resolved = fixture.decisions.resolve(decision.id, 'cancel', 'user')
    expect(resolved.ok).toBe(true)
    // No forced merge was kicked off: the worktree stays ready, main unchanged.
    expect(requireRecord(fixture.worktrees.getById(worktree.id)).state).toBe('ready')
    expect(existsSync(join(fixture.repoDir, 'feature.txt'))).toBe(false)
  })

  it('TASK-130: hard blockers still fail directly without opening a decision', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    // BRANCH_MISSING is overridable: false.
    const deleted = await gitAt(
      fixture,
      fixture.repoDir,
      'update-ref',
      '-d',
      `refs/heads/${worktree.branch}`,
    )
    expect(deleted.exitCode).toBe(0)

    const result = await fixture.service.merge({ worktreeId: worktree.id })
    expect(result).toMatchObject({ ok: false, error: { code: 'MERGE_BLOCKED' } })
    expect(requireOk(fixture.decisions.list({ status: 'open' }))).toEqual([])
  })
})
