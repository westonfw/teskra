import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentRun, GitBranch, IpcResult } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import {
  createAgentRunRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
} from '../db/repositories'
import { createTeskraPaths, type TeskraPaths } from '../paths'
import { createWorkspaceRuntime } from '../workspace/runtime'
import { createResumeService, type ResumeServiceDeps } from './resume-service'

const databases: Database.Database[] = []
const homes: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

interface Fixture {
  readonly paths: TeskraPaths
  readonly runs: ReturnType<typeof createAgentRunRepository>
  readonly worktrees: ReturnType<typeof createWorktreeRepository>
  readonly workspacePath: string
  readonly resume: ReturnType<typeof vi.fn>
  readonly service: (
    overrides?: Partial<ResumeServiceDeps>,
    branch?: Partial<GitBranch>,
  ) => ReturnType<typeof createResumeService>
  readonly createRun: (overrides?: {
    status?: string
    worktreeId?: string
    pid?: number
    processId?: string
  }) => AgentRun
}

function setup(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'teskra-resume-'))
  homes.push(home)
  const workspacePath = join(home, 'repo')
  mkdirSync(workspacePath)
  const database = new Database(':memory:')
  databases.push(database)
  database.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(database)
  if (!migrated.ok) throw new Error(migrated.error.message)
  const workspaces = createWorkspaceRepository(database)
  const created = workspaces.create({
    id: 'workspace-1',
    name: 'Demo',
    runtime: { kind: 'wsl' },
    path: workspacePath,
  })
  if (!created.ok) throw new Error(created.error.message)
  const paths = createTeskraPaths({ TESKRA_HOME: join(home, 'data') })
  const runs = createAgentRunRepository(database)
  const worktrees = createWorktreeRepository(database)
  const resume = vi.fn(
    async (): Promise<IpcResult<AgentRun>> => {
      const run = runs.getById('run-1')
      if (!run.ok || run.data === null) throw new Error('fixture run missing')
      return { ok: true, data: run.data }
    },
  )

  const service: Fixture['service'] = (overrides = {}, branch = {}) =>
    createResumeService({
      runs,
      workspaces,
      worktrees,
      processes: { list: () => [] },
      git: {
        branch: async () => ({
          ok: true as const,
          data: {
            detached: false,
            branches: ['main', 'teskra/run-1'],
            ...branch,
          },
        }),
      },
      agentManager: { resume },
      resolveRuntime: (workspace) =>
        createWorkspaceRuntime(workspace.runtime, { hostPlatform: 'linux', paths }),
      ...overrides,
    })

  const createRun: Fixture['createRun'] = (overrides = {}) => {
    const runDir = paths.runDir('run-1')
    if (!runDir.ok) throw new Error(runDir.error.message)
    const run = runs.create({
      id: 'run-1',
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: runDir.data,
      status: 'interrupted',
      ...(overrides.worktreeId === undefined ? {} : { worktreeId: overrides.worktreeId }),
    })
    if (!run.ok) throw new Error(run.error.message)
    const updated = runs.update('run-1', {
      ...(overrides.status === undefined
        ? {}
        : { status: overrides.status as AgentRun['status'] }),
      ...(overrides.processId === undefined ? {} : { processId: overrides.processId }),
      ...(overrides.pid === undefined ? {} : { pid: overrides.pid }),
    })
    if (!updated.ok || updated.data === null) throw new Error('could not update fixture Run')
    return updated.data
  }

  return { paths, runs, worktrees, workspacePath, resume, service, createRun }
}

describe('ResumeService (TASK-042)', () => {
  it('resumes an interrupted run and delegates to the AgentManager', async () => {
    const fixture = setup()
    fixture.createRun()

    const result = await fixture.service().resume({ runId: 'run-1' })

    expect(result).toMatchObject({ ok: true, data: { id: 'run-1' } })
    expect(fixture.resume).toHaveBeenCalledWith({ runId: 'run-1' })
  })

  it('rejects runs that are not interrupted', async () => {
    const fixture = setup()
    fixture.createRun({ status: 'completed' })

    const result = await fixture.service().resume({ runId: 'run-1' })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'Only interrupted Agent runs can be resumed.' },
    })
    expect(fixture.resume).not.toHaveBeenCalled()
  })

  it('refuses to resume while the persisted PID is still alive', async () => {
    const fixture = setup()
    fixture.createRun({ processId: 'process-1', pid: 4242 })
    const service = fixture.service({
      processes: {
        list: () => [{ id: 'process-2', pid: 4242, startedAt: '2026-09-10T00:00:00.000Z' }],
      },
    })

    const result = await service.resume({ runId: 'run-1' })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', retryable: true },
    })
    expect(fixture.resume).not.toHaveBeenCalled()
  })

  it('refuses to resume when the workspace directory is gone', async () => {
    const fixture = setup()
    fixture.createRun()
    rmSync(fixture.workspacePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })

    const result = await fixture.service().resume({ runId: 'run-1' })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The Run workspace directory no longer exists.',
      },
    })
    expect(fixture.resume).not.toHaveBeenCalled()
  })

  it('refuses to resume from a detached HEAD without a worktree', async () => {
    const fixture = setup()
    fixture.createRun()

    const result = await fixture.service({}, { detached: true }).resume({ runId: 'run-1' })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'The workspace is in detached HEAD state.' },
    })
    expect(fixture.resume).not.toHaveBeenCalled()
  })

  it('resumes a worktree run when the branch and directory still exist', async () => {
    const fixture = setup()
    const worktreePath = join(fixture.workspacePath, 'worktree-run-1')
    mkdirSync(worktreePath)
    const worktree = fixture.worktrees.create({
      id: 'worktree-1',
      workspaceId: 'workspace-1',
      branch: 'teskra/run-1',
      baseBranch: 'main',
      path: worktreePath,
      isolation: 'worktree',
      runId: 'run-1',
      state: 'dirty',
    })
    if (!worktree.ok) throw new Error(worktree.error.message)
    fixture.createRun({ worktreeId: 'worktree-1' })

    const result = await fixture.service().resume({ runId: 'run-1' })

    expect(result).toMatchObject({ ok: true, data: { id: 'run-1' } })
    expect(fixture.resume).toHaveBeenCalledWith({ runId: 'run-1' })
  })

  it('refuses to resume when the worktree branch no longer exists', async () => {
    const fixture = setup()
    const worktreePath = join(fixture.workspacePath, 'worktree-run-1')
    mkdirSync(worktreePath)
    const worktree = fixture.worktrees.create({
      id: 'worktree-1',
      workspaceId: 'workspace-1',
      branch: 'teskra/gone',
      baseBranch: 'main',
      path: worktreePath,
      isolation: 'worktree',
      runId: 'run-1',
      state: 'ready',
    })
    if (!worktree.ok) throw new Error(worktree.error.message)
    fixture.createRun({ worktreeId: 'worktree-1' })

    const result = await fixture.service().resume({ runId: 'run-1' })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'The Run worktree branch no longer exists.' },
    })
    expect(fixture.resume).not.toHaveBeenCalled()
  })

  it('refuses to resume when the worktree was discarded', async () => {
    const fixture = setup()
    const worktreePath = join(fixture.workspacePath, 'worktree-run-1')
    mkdirSync(worktreePath)
    const worktree = fixture.worktrees.create({
      id: 'worktree-1',
      workspaceId: 'workspace-1',
      branch: 'teskra/run-1',
      baseBranch: 'main',
      path: worktreePath,
      isolation: 'worktree',
      runId: 'run-1',
      state: 'discarded',
    })
    if (!worktree.ok) throw new Error(worktree.error.message)
    fixture.createRun({ worktreeId: 'worktree-1' })

    const result = await fixture.service().resume({ runId: 'run-1' })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'The Run worktree is not in a resumable state.' },
    })
    expect(fixture.resume).not.toHaveBeenCalled()
  })
})
