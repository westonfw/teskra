import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import type { IpcResult, MergePreflightCheck, WorkbenchEvents } from '@teskra/contracts'

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
import { createWorktreeManager } from './worktree-manager'

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface Fixture {
  readonly service: ReturnType<typeof createMergePreflightService>
  readonly manager: ReturnType<typeof createWorktreeManager>
  readonly worktrees: ReturnType<typeof createWorktreeRepository>
  readonly tasks: ReturnType<typeof createTaskRepository>
  readonly runs: ReturnType<typeof createAgentRunRepository>
  readonly criteria: ReturnType<typeof createCriteriaRepository>
  readonly reviews: ReturnType<typeof createReviewRepository>
  readonly commands: CommandRunner
  readonly repoDir: string
}

/** Real git repository + in-memory SQLite + native-posix runtime (WSL dev host). */
async function setup(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-preflight-'))
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
    name: 'Preflight fixture',
    runtime: { kind: 'wsl', distro: 'Ubuntu' },
    path: repoDir,
  })
  if (!workspace.ok) throw new Error(workspace.error.message)

  const paths = createTeskraPaths({ TESKRA_HOME: dataRoot })
  const resolveRuntime = (candidate: typeof workspace.data) =>
    createWorkspaceRuntime(candidate.runtime, { hostPlatform: 'linux', paths })
  const manager = createWorktreeManager({
    commands,
    workspaces,
    worktrees,
    events: createEventBus<WorkbenchEvents>(),
    resolveRuntime,
  })
  const service = createMergePreflightService({
    commands,
    workspaces,
    worktrees,
    runs,
    criteria,
    reviews,
    resolveRuntime,
  })
  return { service, manager, worktrees, tasks, runs, criteria, reviews, commands, repoDir }
}

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

function checkById(checks: readonly MergePreflightCheck[], id: string): MergePreflightCheck {
  const check = checks.find((candidate) => candidate.id === id)
  if (check === undefined) throw new Error(`check ${id} missing from preflight result`)
  return check
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

describe('MergePreflightService (TASK-045)', () => {
  it('passes when everything is green and lists skipped checks explicitly', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')

    const result = requireOk(await fixture.service.check({ worktreeId: worktree.id }))
    expect(result.worktreeId).toBe(worktree.id)
    expect(result.status).toBe('pass')
    expect(result.checks.map((check) => check.id)).toEqual([
      'main-clean',
      'worktree-clean',
      'branch-exists',
      'base-branch',
      'no-ongoing-operation',
      'worktree-healthy',
      'required-tests',
      'acceptance-criteria',
    ])
    // Conditional checks are visible as skipped — never silent passes.
    const tests = checkById(result.checks, 'required-tests')
    expect(tests.outcome).toBe('skipped')
    expect(tests.reason).toBeDefined()
    const criteria = checkById(result.checks, 'acceptance-criteria')
    expect(criteria.outcome).toBe('skipped')
    expect(criteria.reason).toContain('Agent run')
    for (const check of result.checks) {
      if (check.outcome !== 'failed') expect(check.blocker).toBeUndefined()
    }
  })

  it('blocks when the main checkout is dirty', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    writeFileSync(join(fixture.repoDir, 'scratch.txt'), 'dirty\n')

    const result = requireOk(await fixture.service.check({ worktreeId: worktree.id }))
    expect(result.status).toBe('blocked')
    expect(checkById(result.checks, 'main-clean')).toMatchObject({
      outcome: 'failed',
      blocker: { code: 'MAIN_WORKSPACE_DIRTY', overridable: true },
    })
  })

  it('blocks when the agent worktree has uncommitted changes', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    writeFileSync(join(worktree.path, 'output.txt'), 'uncommitted\n')

    const result = requireOk(await fixture.service.check({ worktreeId: worktree.id }))
    expect(result.status).toBe('blocked')
    expect(checkById(result.checks, 'worktree-clean')).toMatchObject({
      outcome: 'failed',
      blocker: { code: 'WORKTREE_DIRTY', overridable: true },
    })
  })

  it('blocks when the agent branch no longer exists', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    // Delete the ref directly; `git branch -D` refuses a checked-out branch.
    const deleted = await gitAt(
      fixture,
      fixture.repoDir,
      'update-ref',
      '-d',
      `refs/heads/${worktree.branch}`,
    )
    expect(deleted.exitCode).toBe(0)

    const result = requireOk(await fixture.service.check({ worktreeId: worktree.id }))
    expect(result.status).toBe('blocked')
    expect(checkById(result.checks, 'branch-exists')).toMatchObject({
      outcome: 'failed',
      blocker: { code: 'BRANCH_MISSING', overridable: false },
    })
    // No misleading second blocker for the same root cause.
    expect(checkById(result.checks, 'base-branch').outcome).toBe('skipped')
  })

  it('blocks when the recorded base branch is gone', async () => {
    const fixture = await setup()
    const real = await createWorktree(fixture, 'run-1')
    const ghost = requireOk(
      fixture.worktrees.create({
        id: 'wt-ghost',
        workspaceId: 'workspace-1',
        branch: real.branch,
        baseBranch: 'ghost-base',
        path: real.path,
        isolation: 'worktree',
      }),
    )

    const result = requireOk(await fixture.service.check({ worktreeId: ghost.id }))
    expect(result.status).toBe('blocked')
    expect(checkById(result.checks, 'base-branch')).toMatchObject({
      outcome: 'failed',
      blocker: { code: 'BASE_BRANCH_MISSING', overridable: false },
    })
  })

  it('blocks when the base branch moved ahead of the agent branch', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    // Advance main past the fork point: it is no longer an ancestor.
    writeFileSync(join(fixture.repoDir, 'main-moved.txt'), 'moved\n')
    await gitAt(fixture, fixture.repoDir, 'add', '--all')
    await gitAt(fixture, fixture.repoDir, 'commit', '--message', 'feat: main moves on')

    const result = requireOk(await fixture.service.check({ worktreeId: worktree.id }))
    expect(result.status).toBe('blocked')
    expect(checkById(result.checks, 'base-branch')).toMatchObject({
      outcome: 'failed',
      blocker: { code: 'BASE_BRANCH_MISMATCH', overridable: true },
    })
  })

  it('blocks while a merge is in progress inside the worktree', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    // Conflicting edits: agent branch vs main.
    writeFileSync(join(worktree.path, 'README.md'), 'agent edit\n')
    await gitAt(fixture, worktree.path, 'add', '--all')
    await gitAt(fixture, worktree.path, 'commit', '--message', 'agent: edit readme')
    writeFileSync(join(fixture.repoDir, 'README.md'), 'main edit\n')
    await gitAt(fixture, fixture.repoDir, 'add', '--all')
    await gitAt(fixture, fixture.repoDir, 'commit', '--message', 'feat: edit readme on main')
    const merge = await gitAt(fixture, worktree.path, 'merge', 'main')
    expect(merge.exitCode).not.toBe(0) // conflict → MERGE_HEAD stays behind

    const result = requireOk(await fixture.service.check({ worktreeId: worktree.id }))
    expect(result.status).toBe('blocked')
    expect(checkById(result.checks, 'no-ongoing-operation')).toMatchObject({
      outcome: 'failed',
      blocker: { code: 'ONGOING_OPERATION', overridable: false },
    })
  })

  it('skips the criteria check for draft-only sets and blocks on unmet required criteria', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    requireOk(
      fixture.tasks.create({ id: 'task-1', workspaceId: 'workspace-1', title: 'Criteria task' }),
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

    // Draft set: not a confirmed contract → skipped, still visible.
    requireOk(fixture.criteria.createSet({ id: 'set-1', taskId: 'task-1', version: 1 }))
    const draft = requireOk(await fixture.service.check({ worktreeId: worktree.id }))
    expect(checkById(draft.checks, 'acceptance-criteria')).toMatchObject({
      outcome: 'skipped',
      reason: 'No confirmed acceptance criteria set.',
    })

    // Confirmed set with one required criterion and no scores → blocker.
    requireOk(fixture.criteria.confirmSet('set-1'))
    const criterion = requireOk(
      fixture.criteria.addCriterion({
        id: 'crit-1',
        criteriaSetId: 'set-1',
        ordinal: 1,
        description: 'Unit tests cover the change',
        required: true,
      }),
    )
    const unmet = requireOk(await fixture.service.check({ worktreeId: worktree.id }))
    expect(unmet.status).toBe('blocked')
    const unmetCheck = checkById(unmet.checks, 'acceptance-criteria')
    expect(unmetCheck).toMatchObject({
      outcome: 'failed',
      blocker: { code: 'CRITERIA_UNMET', overridable: true },
    })
    expect(unmetCheck.blocker?.message).toContain('Unit tests cover the change')

    // A passing score for this run clears the blocker.
    requireOk(
      fixture.reviews.recordScore({
        id: 'score-1',
        runId: 'run-1',
        criterionId: criterion.id,
        result: 'pass',
      }),
    )
    const met = requireOk(await fixture.service.check({ worktreeId: worktree.id }))
    expect(met.status).toBe('pass')
    expect(checkById(met.checks, 'acceptance-criteria').outcome).toBe('pass')
  })

  it('is read-only: preflight never alters git or database state', async () => {
    const fixture = await setup()
    const worktree = await createWorktree(fixture, 'run-1')
    // Leave the scene messy: dirty main + dirty worktree, preflight still blocked.
    writeFileSync(join(fixture.repoDir, 'scratch.txt'), 'dirty\n')
    writeFileSync(join(worktree.path, 'output.txt'), 'uncommitted\n')

    const snapshot = async () => ({
      mainStatus: (await gitAt(fixture, fixture.repoDir, 'status', '--porcelain')).stdout,
      worktreeStatus: (await gitAt(fixture, worktree.path, 'status', '--porcelain')).stdout,
      mainHead: (await gitAt(fixture, fixture.repoDir, 'rev-parse', 'HEAD')).stdout,
      worktreeHead: (await gitAt(fixture, worktree.path, 'rev-parse', 'HEAD')).stdout,
      record: requireOk(fixture.worktrees.getById(worktree.id)),
    })
    const before = await snapshot()
    const result = requireOk(await fixture.service.check({ worktreeId: worktree.id }))
    expect(result.status).toBe('blocked')
    const after = await snapshot()
    expect(after).toEqual(before)
  })

  it('fails closed for unknown worktrees', async () => {
    const fixture = await setup()
    const result = await fixture.service.check({ worktreeId: 'nope' })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })
})
