import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IpcResult, WorkbenchEvents, Workspace } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import {
  createAgentRunRepository,
  createHandoffRepository,
  createTaskRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
} from '../db/repositories'
import type { AgentRunRepository } from '../db/repositories/agent-run-repository'
import type { HandoffRepository } from '../db/repositories/handoff-repository'
import type { Worktree } from '../db/repositories/worktree-repository'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createTeskraPaths } from '../paths'
import {
  createCommandRunner,
  type CommandRequest,
  type CommandRunner,
} from '../process/command-runner'
import { createWorkspaceRuntime } from '../workspace/runtime'
import {
  buildCommitMessage,
  createAutoCommitService,
  DEFAULT_SUMMARY,
  SUBJECT_LIMIT,
  type AutoCommitService,
} from './auto-commit-service'
import { createWorktreeManager } from './worktree-manager'

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface Fixture {
  readonly service: AutoCommitService
  readonly commands: CommandRunner
  readonly requests: CommandRequest[]
  readonly events: EventBus<WorkbenchEvents>
  readonly runs: AgentRunRepository
  readonly handoffs: HandoffRepository
  readonly worktrees: ReturnType<typeof createWorktreeRepository>
  readonly worktreeManager: ReturnType<typeof createWorktreeManager>
  readonly repoDir: string
  readonly dataRoot: string
}

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

/** Real git repository + in-memory SQLite + native-posix runtime (WSL dev host). */
async function setup(commands?: CommandRunner): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-autocommit-'))
  directories.push(directory)
  const repoDir = join(directory, 'repo')
  const dataRoot = join(directory, 'data-root')
  mkdirSync(repoDir)
  const real = createCommandRunner({ hostPlatform: 'linux' })
  const git = async (...args: string[]) => {
    const result = await real.run({ command: 'git', args, cwd: repoDir, timeoutMs: 15_000 })
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
  const tasks = createTaskRepository(database)
  const runs = createAgentRunRepository(database)
  const worktrees = createWorktreeRepository(database)
  const handoffs = createHandoffRepository(database)
  const workspace = workspaces.create({
    id: 'workspace-1',
    name: 'Auto-commit fixture',
    runtime: { kind: 'wsl', distro: 'Ubuntu' },
    path: repoDir,
  })
  if (!workspace.ok) throw new Error(workspace.error.message)
  const task = tasks.create({ id: 'task-103', workspaceId: 'workspace-1', title: 'Rate history' })
  if (!task.ok) throw new Error(task.error.message)

  const events = createEventBus<WorkbenchEvents>()
  const paths = createTeskraPaths({ TESKRA_HOME: dataRoot })
  const resolveRuntime = (candidate: Workspace) =>
    createWorkspaceRuntime(candidate.runtime, { hostPlatform: 'linux', paths })

  // Recording proxy: every git invocation is observable for the no-push and
  // main-workspace assertions while the real runner does the work.
  const requests: CommandRequest[] = []
  const recording: CommandRunner = {
    async run(request) {
      requests.push(request)
      return (commands ?? real).run(request)
    },
  }
  const worktreeManager = createWorktreeManager({
    commands: real,
    workspaces,
    worktrees,
    events,
    resolveRuntime,
  })
  const service = createAutoCommitService({
    commands: recording,
    runs,
    workspaces,
    worktrees,
    handoffs,
    events,
    resolveRuntime,
  })
  return {
    service,
    commands: real,
    requests,
    events,
    runs,
    handoffs,
    worktrees,
    worktreeManager,
    repoDir,
    dataRoot,
  }
}

function createCompletedRun(
  fixture: Fixture,
  input: { runId: string; worktreeId?: string; taskId?: string; prompt?: string },
) {
  const created = fixture.runs.create({
    id: input.runId,
    workspaceId: 'workspace-1',
    agentType: 'codex',
    executionMode: 'orchestrated',
    runDir: join(fixture.dataRoot, 'runs', input.runId),
    status: 'completed',
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
  })
  return requireOk(created)
}

async function gitIn(fixture: Fixture, cwd: string, ...args: string[]): Promise<string> {
  const result = await fixture.commands.run({ command: 'git', args, cwd, timeoutMs: 15_000 })
  return requireOk(result).stdout
}

function headOf(fixture: Fixture, cwd: string): Promise<string> {
  return gitIn(fixture, cwd, 'rev-parse', 'HEAD').then((out) => out.trim())
}

function gitVerbs(fixture: Fixture): string[] {
  return fixture.requests.map((request) => request.args?.[0] ?? '')
}

describe('buildCommitMessage (TASK-087 / ADR-0003)', () => {
  it('pins agent(<agentId>): <taskId> <summary> with runId and handoff summary in the body', () => {
    const message = buildCommitMessage({
      agentId: 'codex',
      taskId: 'TASK-103',
      runId: 'run-1',
      summary: 'implement rate history api',
      handoffSummary: 'implement rate history api',
    })
    expect(message).toBe(
      'agent(codex): TASK-103 implement rate history api\n\nimplement rate history api\n\nRun: run-1',
    )
  })

  it('omits the task segment entirely when the run has no taskId (fixed choice)', () => {
    const message = buildCommitMessage({
      agentId: 'claude',
      runId: 'run-2',
      summary: 'fix the flaky test',
    })
    expect(message).toBe('agent(claude): fix the flaky test\n\nRun: run-2')
    expect(message).not.toContain('  ')
  })

  it('truncates the subject at 72 characters without cutting the body', () => {
    const message = buildCommitMessage({
      agentId: 'codex',
      taskId: 'TASK-1',
      runId: 'run-3',
      summary: 'x'.repeat(200),
    })
    const [subject, body] = message.split('\n\n')
    expect(subject?.length).toBeLessThanOrEqual(SUBJECT_LIMIT)
    expect(subject).toMatch(/^agent\(codex\): TASK-1 x+$/u)
    expect(body).toBe('Run: run-3')
  })
})

describe('AutoCommitService (TASK-087)', () => {
  it('commits worktree changes on run completion with agentId/taskId/runId in the message', async () => {
    const fixture = await setup()
    const worktree = requireOk(
      await fixture.worktreeManager.create({
        workspaceId: 'workspace-1',
        runId: 'run-1',
        taskId: 'task-103',
        agentId: 'codex',
      }),
    )
    createCompletedRun(fixture, {
      runId: 'run-1',
      worktreeId: worktree.id,
      taskId: 'task-103',
      prompt: 'implement rate history api',
    })
    const handoff = fixture.handoffs.save({
      id: 'handoff-1',
      runId: 'run-1',
      type: 'implementation',
      payload: { summary: 'implement rate history api' },
      parseStatus: 'degraded',
    })
    if (!handoff.ok) throw new Error(handoff.error.message)
    writeFileSync(join(worktree.path, 'rates.ts'), 'export const rates = []\n')

    const mainHeadBefore = await headOf(fixture, fixture.repoDir)
    const committedEvent = vi.fn()
    fixture.events.subscribe('agent.committed', committedEvent)

    const outcome = requireOk(await fixture.service.commitCompletedRun('run-1'))
    expect(outcome).toMatchObject({ kind: 'committed' })
    const worktreeHead = await headOf(fixture, worktree.path)
    expect(outcome).toMatchObject({ kind: 'committed', commitHash: worktreeHead })

    const message = await gitIn(fixture, worktree.path, 'log', '--format=%B', '-1')
    expect(message).toContain('agent(codex): task-103 implement rate history api')
    expect(message).toContain('Run: run-1')
    expect(committedEvent).toHaveBeenCalledWith({
      runId: 'run-1',
      worktreeId: worktree.id,
      commitHash: worktreeHead,
    })

    // The main workspace was never committed: HEAD untouched, message absent.
    expect(await headOf(fixture, fixture.repoDir)).toBe(mainHeadBefore)
    const mainLog = await gitIn(fixture, fixture.repoDir, 'log', '--format=%s')
    expect(mainLog).not.toContain('agent(codex)')
    expect(fixture.requests.every((request) => request.cwd === worktree.path)).toBe(true)

    // No push path exists: only status/add/commit/rev-parse were issued.
    expect(gitVerbs(fixture).sort()).toEqual(['add', 'commit', 'rev-parse', 'status'])
    expect(fixture.requests.flatMap((request) => request.args ?? [])).not.toContain('push')
  })

  it('skips cleanly when the worktree has no changes (no empty commit)', async () => {
    const fixture = await setup()
    const worktree = requireOk(
      await fixture.worktreeManager.create({ workspaceId: 'workspace-1', runId: 'run-1' }),
    )
    createCompletedRun(fixture, { runId: 'run-1', worktreeId: worktree.id })
    const headBefore = await headOf(fixture, worktree.path)

    const outcome = requireOk(await fixture.service.commitCompletedRun('run-1'))
    expect(outcome).toEqual({ kind: 'skipped', reason: 'no-changes' })
    expect(await headOf(fixture, worktree.path)).toBe(headBefore)
    expect(gitVerbs(fixture)).toEqual(['status'])
  })

  it('never touches git for a run without a worktree (main workspace protection)', async () => {
    const fixture = await setup()
    createCompletedRun(fixture, { runId: 'run-1' })
    const mainHeadBefore = await headOf(fixture, fixture.repoDir)
    writeFileSync(join(fixture.repoDir, 'uncommitted.txt'), 'agent output in main workspace\n')

    const outcome = requireOk(await fixture.service.commitCompletedRun('run-1'))
    expect(outcome).toEqual({ kind: 'skipped', reason: 'no-worktree' })
    expect(fixture.requests).toEqual([])
    expect(await headOf(fixture, fixture.repoDir)).toBe(mainHeadBefore)
    expect(existsSync(join(fixture.repoDir, 'uncommitted.txt'))).toBe(true)
  })

  it('refuses a worktree record pointing at the main workspace', async () => {
    const fixture = await setup()
    const record = fixture.worktrees.create({
      id: 'worktree-bogus',
      workspaceId: 'workspace-1',
      runId: 'run-1',
      branch: 'main',
      baseBranch: 'main',
      path: fixture.repoDir,
      isolation: 'worktree',
      state: 'ready',
    })
    const bogus: Worktree = requireOk(record)
    createCompletedRun(fixture, { runId: 'run-1', worktreeId: bogus.id })
    const mainHeadBefore = await headOf(fixture, fixture.repoDir)

    const outcome = await fixture.service.commitCompletedRun('run-1')
    expect(outcome).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(fixture.requests).toEqual([])
    expect(await headOf(fixture, fixture.repoDir)).toBe(mainHeadBefore)
  })

  it('falls back to the prompt first line, then to the default summary', async () => {
    const fixture = await setup()
    const prompted = requireOk(
      await fixture.worktreeManager.create({ workspaceId: 'workspace-1', runId: 'run-prompt' }),
    )
    createCompletedRun(fixture, {
      runId: 'run-prompt',
      worktreeId: prompted.id,
      prompt: '\nFix the flaky login test\nwith more detail here',
    })
    writeFileSync(join(prompted.path, 'login.test.ts'), 'test\n')
    requireOk(await fixture.service.commitCompletedRun('run-prompt'))
    expect(await gitIn(fixture, prompted.path, 'log', '--format=%s', '-1')).toContain(
      `agent(codex): Fix the flaky login test`,
    )

    const plain = requireOk(
      await fixture.worktreeManager.create({ workspaceId: 'workspace-1', runId: 'run-plain' }),
    )
    createCompletedRun(fixture, { runId: 'run-plain', worktreeId: plain.id })
    writeFileSync(join(plain.path, 'out.txt'), 'output\n')
    requireOk(await fixture.service.commitCompletedRun('run-plain'))
    expect(await gitIn(fixture, plain.path, 'log', '--format=%s', '-1')).toContain(
      `agent(codex): ${DEFAULT_SUMMARY}`,
    )
  })

  it('keeps the run completed and the changes uncommitted when the commit fails', async () => {
    const real = createCommandRunner({ hostPlatform: 'linux' })
    const failingCommit: CommandRunner = {
      async run(request) {
        if (request.args?.[0] === 'commit') {
          return { ok: true, data: { stdout: '', stderr: 'boom: hook rejected', exitCode: 1 } }
        }
        return real.run(request)
      },
    }
    const fixture = await setup(failingCommit)
    const worktree = requireOk(
      await fixture.worktreeManager.create({
        workspaceId: 'workspace-1',
        runId: 'run-1',
        taskId: 'task-103',
        agentId: 'codex',
      }),
    )
    createCompletedRun(fixture, { runId: 'run-1', worktreeId: worktree.id, taskId: 'task-103' })
    writeFileSync(join(worktree.path, 'rates.ts'), 'export const rates = []\n')
    const headBefore = await headOf(fixture, worktree.path)

    const outcome = await fixture.service.commitCompletedRun('run-1')
    expect(outcome).toMatchObject({ ok: false, error: { code: 'UNKNOWN' } })

    // The Run row is untouched (still completed) and the changes survive.
    const run = requireOk(fixture.runs.getById('run-1'))
    expect(run?.status).toBe('completed')
    expect(existsSync(join(worktree.path, 'rates.ts'))).toBe(true)
    expect(await headOf(fixture, worktree.path)).toBe(headBefore)
    const status = await gitIn(fixture, worktree.path, 'status', '--porcelain')
    expect(status).toContain('rates.ts')

    // Even on the failure path nothing pushed.
    expect(gitVerbs(fixture)).not.toContain('push')
  })

  it('reacts to the agent.completed event through the real EventBus', async () => {
    const fixture = await setup()
    const worktree = requireOk(
      await fixture.worktreeManager.create({
        workspaceId: 'workspace-1',
        runId: 'run-1',
        taskId: 'task-103',
        agentId: 'codex',
      }),
    )
    createCompletedRun(fixture, { runId: 'run-1', worktreeId: worktree.id, taskId: 'task-103' })
    writeFileSync(join(worktree.path, 'rates.ts'), 'export const rates = []\n')

    const committed = new Promise<{ runId: string; commitHash: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('agent.committed never fired')), 10_000)
      fixture.events.subscribe('agent.committed', (payload) => {
        clearTimeout(timer)
        resolve(payload)
      })
    })
    fixture.events.emit('agent.completed', { runId: 'run-1', exitCode: 0 })

    const payload = await committed
    expect(payload).toMatchObject({ runId: 'run-1', worktreeId: worktree.id })
    expect(await headOf(fixture, worktree.path)).toBe(payload.commitHash)

    // A failure through the event path resolves as a logged warning, never a
    // throw or unhandled rejection.
    fixture.events.emit('agent.completed', { runId: 'run-missing', exitCode: 0 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    fixture.service.dispose()
  })
})
