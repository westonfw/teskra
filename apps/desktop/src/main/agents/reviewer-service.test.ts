import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IpcResult, WorkbenchEvents, Worktree } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import {
  createAgentEventRepository,
  createAgentRunRepository,
  createHandoffRepository,
  createTaskRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createWorktreeManager, type WorktreeManager } from '../git/worktree-manager'
import { createTeskraPaths } from '../paths'
import { createCommandRunner, type CommandRunner } from '../process/command-runner'
import { createWorkspaceRuntime } from '../workspace/runtime'
import { buildCodexArguments } from './adapters/codex-adapter'
import type { CodingAgentAdapter } from './adapters/coding-agent-adapter'
import { createAgentManager, type AgentManager } from './agent-manager'
import { createDefaultAgentRegistry } from './agent-registry'
import { CODEX_AGENT } from './definitions/codex'
import { FAKE_AGENT } from './definitions/fake'
import { createReviewerService, type ReviewerService } from './reviewer-service'
import { createRunLogStore } from './run-log-store'

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

function mockAdapter(definition: typeof CODEX_AGENT | typeof FAKE_AGENT): CodingAgentAdapter {
  return {
    definition,
    detect: vi.fn(async ({ runtime }) => ({
      ok: true as const,
      data: {
        agentId: definition.id,
        runtime,
        installed: true,
        executable: definition.executable.command,
        version: 'test',
        overridden: false,
        fromCache: false,
        checkedAt: '2026-09-10T00:00:00.000Z',
      },
    })),
    start: vi.fn(async (request: { runId: string }) => ({
      ok: true as const,
      data: {
        runId: request.runId,
        processId: `${definition.id}:${request.runId}`,
        pid: 4242,
        startedAt: '2026-09-10T00:00:01.000Z',
      },
    })),
    send: vi.fn(async () => ({ ok: true as const, data: undefined })),
    cancel: vi.fn(async () => ({ ok: true as const, data: undefined })),
  }
}

interface Fixture {
  readonly service: ReviewerService
  readonly agents: AgentManager
  readonly worktreeManager: WorktreeManager
  readonly worktrees: ReturnType<typeof createWorktreeRepository>
  readonly tasks: ReturnType<typeof createTaskRepository>
  readonly events: EventBus<WorkbenchEvents>
  readonly commands: CommandRunner
  readonly adapters: { readonly codex: CodingAgentAdapter; readonly fake: CodingAgentAdapter }
  readonly repoDir: string
}

/** Real git repository + in-memory SQLite; adapters are mocked (TASK-052). */
async function setup(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-reviewer-'))
  directories.push(directory)
  const repoDir = join(directory, 'repo')
  const dataRoot = join(directory, 'data-root')
  mkdirSync(repoDir)
  const commands = createCommandRunner()
  const git = async (...args: string[]) => {
    const result = await commands.run({ command: 'git', args, cwd: repoDir, timeoutMs: 15_000 })
    if (!result.ok || result.data.exitCode !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed: ${
          result.ok
            ? `exit=${String(result.data.exitCode)} stderr=${JSON.stringify(result.data.stderr)} stdout=${JSON.stringify(result.data.stdout)}`
            : `${result.error.code}: ${result.error.message}`
        }`,
      )
    }
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
  const workspace = workspaces.create(
    {
      id: 'workspace-1',
      name: 'Reviewer fixture',
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      path: repoDir,
    },
    '2026-09-10T00:00:00.000Z',
  )
  if (!workspace.ok) throw new Error(workspace.error.message)

  const events = createEventBus<WorkbenchEvents>()
  const paths = createTeskraPaths({ TESKRA_HOME: dataRoot })
  const resolveRuntime = (candidate: typeof workspace.data) =>
    createWorkspaceRuntime(candidate.runtime, { hostPlatform: 'linux', paths })
  const worktreeManager = createWorktreeManager({
    commands,
    workspaces,
    worktrees,
    events,
    resolveRuntime,
  })
  const registry = createDefaultAgentRegistry(true)
  if (!registry.ok) throw new Error(registry.error.message)
  const codex = mockAdapter(CODEX_AGENT)
  const fake = mockAdapter(FAKE_AGENT)
  let tick = 0
  const agents = createAgentManager({
    registry: registry.data,
    adapters: [codex, fake],
    runs,
    agentEvents: createAgentEventRepository(database),
    handoffs: createHandoffRepository(database),
    workspaces,
    tasks,
    worktrees,
    events,
    paths,
    runLogs: createRunLogStore({ paths }),
    now: () => `2026-09-10T00:00:${String(tick++).padStart(2, '0')}.000Z`,
  })
  let nextReviewRun = 1
  const service = createReviewerService({
    registry: registry.data,
    agents,
    worktreeManager,
    runs,
    worktrees,
    events,
    createRunId: () => `review-run-${String(nextReviewRun++)}`,
  })
  return {
    service,
    agents,
    worktreeManager,
    worktrees,
    tasks,
    events,
    commands,
    adapters: { codex, fake },
    repoDir,
  }
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

function finishRun(fixture: Fixture, runId: string, agentId: string, exitCode = 0): void {
  fixture.events.emit('process.exited', {
    processId: `${agentId}:${runId}`,
    agentRunId: runId,
    exitCode,
  })
}

/** Completed implement run bound to a real worktree holding a committed change. */
async function implementRun(
  fixture: Fixture,
  id: string,
  options: { taskId?: string } = {},
): Promise<{ runId: string; worktree: Worktree }> {
  const worktree = requireOk(
    await fixture.worktreeManager.create({
      workspaceId: 'workspace-1',
      runId: id,
      baseBranch: 'main',
    }),
  )
  const started = requireOk(
    await fixture.agents.start({
      runId: id,
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionMode: 'orchestrated',
      worktreeId: worktree.id,
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    }),
  )
  writeFileSync(join(worktree.path, 'feature.txt'), `implement output ${id}\n`)
  await gitAt(fixture, worktree.path, 'add', '--all')
  await gitAt(fixture, worktree.path, 'commit', '--message', 'agent: implement')
  finishRun(fixture, started.id, 'codex')
  return { runId: started.id, worktree }
}

describe('ReviewerService (TASK-052)', () => {
  it('runs a read-only-capable reviewer read-only inside the implement worktree', async () => {
    const fixture = await setup()
    const implement = await implementRun(fixture, 'impl-1')

    const result = requireOk(
      await fixture.service.startReview({
        workspaceId: 'workspace-1',
        agentType: 'codex',
        targetWorktreeId: implement.worktree.id,
        prompt: 'Review the change.',
      }),
    )

    expect(result.isolation).toBe('worktree-readonly')
    expect(result.run).toMatchObject({
      role: 'reviewer',
      approvalMode: 'read-only',
      worktreeId: implement.worktree.id,
      status: 'running',
    })
    const start = vi.mocked(fixture.adapters.codex.start).mock.calls.at(-1)?.[0]
    expect(start).toMatchObject({
      approvalMode: 'read-only',
      // Reviewers are unattended workers: headless by default so the CLI
      // exits after its turn instead of idling at an interactive prompt.
      mode: 'exec',
      worktreePath: implement.worktree.path,
      prompt: 'Review the change.',
    })
    // The real Codex Adapter translates that request into its own read-only
    // mechanism (ADR-0002 policy projection).
    expect(start === undefined ? [] : buildCodexArguments(start)).toEqual(
      expect.arrayContaining(['--sandbox', 'read-only', '--ask-for-approval', 'on-request']),
    )

    finishRun(fixture, result.run.id, 'codex')

    // The review left the implement worktree untouched: clean tree, and the
    // record keeps its state/isolation (snapshot cleanup must not fire).
    const status = await gitAt(fixture, implement.worktree.path, 'status', '--porcelain')
    expect(status.stdout.trim()).toBe('')
    expect(requireRecord(fixture.worktrees.getById(implement.worktree.id))).toMatchObject({
      state: 'ready',
      isolation: 'worktree',
    })
    expect(requireOk(fixture.agents.get(result.run.id))).toMatchObject({ status: 'completed' })
  })

  it('injects TESKRA_REVIEW_TARGET_RUN_ID so reviews can attribute scores (TASK-054)', async () => {
    const fixture = await setup()
    const implement = await implementRun(fixture, 'impl-1')

    const result = requireOk(
      await fixture.service.startReview({
        workspaceId: 'workspace-1',
        agentType: 'codex',
        targetRunId: implement.runId,
        prompt: 'Review the change.',
      }),
    )

    expect(result.isolation).toBe('worktree-readonly')
    const start = vi.mocked(fixture.adapters.codex.start).mock.calls.at(-1)?.[0]
    expect(start?.environment).toEqual({ TESKRA_REVIEW_TARGET_RUN_ID: implement.runId })

    // Without a resolvable target there is nothing to attribute.
    const untargeted = requireOk(
      await fixture.service.startReview({ workspaceId: 'workspace-1', agentType: 'codex' }),
    )
    expect(untargeted.isolation).toBe('shared-readonly')
    const second = vi.mocked(fixture.adapters.codex.start).mock.calls.at(-1)?.[0]
    expect(second?.environment).toBeUndefined()
  })

  it('falls back to shared-readonly in the main workspace without a review target', async () => {
    const fixture = await setup()

    const result = requireOk(
      await fixture.service.startReview({
        workspaceId: 'workspace-1',
        agentType: 'codex',
        prompt: 'Review the workspace.',
      }),
    )

    expect(result.isolation).toBe('shared-readonly')
    expect(result.run).toMatchObject({ role: 'reviewer', approvalMode: 'read-only' })
    expect(result.run.worktreeId).toBeUndefined()
    const start = vi.mocked(fixture.adapters.codex.start).mock.calls.at(-1)?.[0]
    expect(start).toMatchObject({ approvalMode: 'read-only' })
    expect(start?.worktreePath).toBeUndefined()
  })

  it('targets the latest worktree-bearing run of the task (taskId association)', async () => {
    const fixture = await setup()
    requireOk(
      fixture.tasks.create({ id: 'task-1', workspaceId: 'workspace-1', title: 'Reviewed task' }),
    )
    const older = await implementRun(fixture, 'impl-1', { taskId: 'task-1' })
    const latest = await implementRun(fixture, 'impl-2', { taskId: 'task-1' })

    const result = requireOk(
      await fixture.service.startReview({
        workspaceId: 'workspace-1',
        agentType: 'codex',
        taskId: 'task-1',
      }),
    )

    expect(result.isolation).toBe('worktree-readonly')
    expect(result.run.worktreeId).toBe(latest.worktree.id)
    expect(result.run.worktreeId).not.toBe(older.worktree.id)
  })

  it('never targets a previous reviewer run’s discarded snapshot (taskId association)', async () => {
    const fixture = await setup()
    requireOk(
      fixture.tasks.create({ id: 'task-1', workspaceId: 'workspace-1', title: 'Reviewed task' }),
    )
    const implement = await implementRun(fixture, 'impl-1', { taskId: 'task-1' })

    // A fake-agent review runs in a disposable snapshot that is discarded as
    // soon as the review ends — it must never become the next review target.
    const first = requireOk(
      await fixture.service.startReview({
        workspaceId: 'workspace-1',
        agentType: 'fake',
        taskId: 'task-1',
      }),
    )
    const snapshotId = first.run.worktreeId ?? ''
    finishRun(fixture, first.run.id, 'fake')
    await vi.waitFor(() => {
      expect(requireRecord(fixture.worktrees.getById(snapshotId)).state).toBe('discarded')
    })

    const second = requireOk(
      await fixture.service.startReview({
        workspaceId: 'workspace-1',
        agentType: 'codex',
        taskId: 'task-1',
      }),
    )

    expect(second.isolation).toBe('worktree-readonly')
    expect(second.run.worktreeId).toBe(implement.worktree.id)
    expect(second.run.worktreeId).not.toBe(snapshotId)
  })

  it('sandboxes a reviewer without read-only support in a discarded disposable snapshot', async () => {
    const fixture = await setup()
    const implement = await implementRun(fixture, 'impl-1')

    const result = requireOk(
      await fixture.service.startReview({
        workspaceId: 'workspace-1',
        agentType: 'fake',
        targetRunId: implement.runId,
        prompt: 'Review the change.',
      }),
    )

    expect(result.isolation).toBe('disposable-snapshot')
    expect(result.run).toMatchObject({ id: 'review-run-1', role: 'reviewer' })
    const snapshot = requireRecord(fixture.worktrees.getById(result.run.worktreeId ?? ''))
    expect(snapshot).toMatchObject({
      isolation: 'disposable-snapshot',
      runId: 'review-run-1',
      baseBranch: implement.worktree.branch,
    })
    expect(snapshot.path).not.toBe(implement.worktree.path)
    // The snapshot carries the implement branch's committed output.
    expect(existsSync(join(snapshot.path, 'feature.txt'))).toBe(true)
    // The fake CLI cannot enforce read-only, so no read-only approvalMode is
    // projected — the snapshot itself is the write boundary (plan §126).
    const start = vi.mocked(fixture.adapters.fake.start).mock.calls.at(-1)?.[0]
    expect(start).toMatchObject({ worktreePath: snapshot.path, mode: 'exec' })
    expect(start?.approvalMode).not.toBe('read-only')

    // The reviewer may trash the snapshot however it likes.
    writeFileSync(join(snapshot.path, 'junk.txt'), 'reviewer made a mess\n')
    await gitAt(fixture, snapshot.path, 'add', '--all')
    await gitAt(fixture, snapshot.path, 'commit', '--message', 'reviewer: scratch')
    finishRun(fixture, result.run.id, 'fake')

    // Review over: the snapshot is discarded whole...
    await vi.waitFor(() => {
      expect(requireRecord(fixture.worktrees.getById(snapshot.id)).state).toBe('discarded')
    })
    expect(existsSync(snapshot.path)).toBe(false)
    const worktreeList = await gitAt(fixture, fixture.repoDir, 'worktree', 'list', '--porcelain')
    expect(worktreeList.stdout).not.toContain(snapshot.path)

    // ...and the implement worktree was never polluted.
    const status = await gitAt(fixture, implement.worktree.path, 'status', '--porcelain')
    expect(status.stdout.trim()).toBe('')
    const implementRecord = requireRecord(fixture.worktrees.getById(implement.worktree.id))
    expect(implementRecord.state).not.toBe('discarded')

    // The discarded snapshot is a safe leftover for TASK-047 batch cleanup.
    const cleanup = requireOk(await fixture.worktreeManager.cleanup({ workspaceId: 'workspace-1' }))
    expect(cleanup.skippedIds).not.toContain(snapshot.id)
  })

  it('discards the snapshot when the reviewer fails to start', async () => {
    const fixture = await setup()
    await implementRun(fixture, 'impl-1')
    fixture.adapters.fake.start = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'UNKNOWN' as const,
        message: 'spawn failed',
        retryable: true,
      },
    }))

    // AgentManager records the launch failure as a failed Run (it does not
    // propagate an IPC error); the agent.failed event still triggers the
    // snapshot discard.
    const result = requireOk(
      await fixture.service.startReview({
        workspaceId: 'workspace-1',
        agentType: 'fake',
      }),
    )

    expect(result.run).toMatchObject({ status: 'failed' })
    const snapshot = requireRecord(fixture.worktrees.getByRunId('review-run-1'))
    await vi.waitFor(() => {
      expect(requireRecord(fixture.worktrees.getById(snapshot.id)).state).toBe('discarded')
    })
    expect(existsSync(snapshot.path)).toBe(false)
  })

  it('discards the snapshot when the review is cancelled', async () => {
    const fixture = await setup()

    const result = requireOk(
      await fixture.service.startReview({ workspaceId: 'workspace-1', agentType: 'fake' }),
    )
    const snapshotId = result.run.worktreeId ?? ''
    await fixture.agents.cancel(result.run.id)

    await vi.waitFor(() => {
      expect(requireRecord(fixture.worktrees.getById(snapshotId)).state).toBe('discarded')
    })
  })

  it('fails closed for unknown agents and dangling review targets', async () => {
    const fixture = await setup()

    await expect(
      fixture.service.startReview({ workspaceId: 'workspace-1', agentType: 'nope' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    await expect(
      fixture.service.startReview({
        workspaceId: 'workspace-1',
        agentType: 'codex',
        targetRunId: 'missing-run',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    await expect(
      fixture.service.startReview({
        workspaceId: 'workspace-1',
        agentType: 'codex',
        targetWorktreeId: 'missing-worktree',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(fixture.adapters.codex.start).not.toHaveBeenCalled()
    expect(fixture.adapters.fake.start).not.toHaveBeenCalled()
  })
})
