import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IpcResult, WorkbenchEvents } from '@teskra/contracts'

import { createRunLogStore } from '../agents/run-log-store'
import { migrateDatabase } from '../db/migrations'
import {
  createAgentEventRepository,
  createAgentRunRepository,
  createTaskRepository,
  createWorkspaceRepository,
  createWorktreeRepository,
} from '../db/repositories'
import { createEventBus } from '../events/event-bus'
import { createTeskraPaths } from '../paths'
import type { CommandRunner } from '../process/command-runner'
import type { HostProcessControl } from '../process/host-processes'
import { createWorkspaceRuntime } from '../workspace/runtime'
import { createReconciliationService } from './reconciliation-service'

const databases: Database.Database[] = []
const homes: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

function setup(workspaceExists = true) {
  const home = mkdtempSync(join(tmpdir(), 'teskra-reconcile-'))
  homes.push(home)
  const workspacePath = join(home, workspaceExists ? 'repo' : 'missing-repo')
  if (workspaceExists) mkdirSync(workspacePath)
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
  const agentEvents = createAgentEventRepository(database)
  const tasks = createTaskRepository(database)
  const worktrees = createWorktreeRepository(database)
  const events = createEventBus<WorkbenchEvents>()
  const commands: CommandRunner = {
    run: vi.fn(async () => ({
      ok: true as const,
      data: { stdout: '', stderr: 'not a worktree', exitCode: 128 },
    })),
  }

  const service = (
    processes: {
      list(): readonly {
        id: string
        pid: number
        agentRunId?: string
        startedAt: string
      }[]
    } = { list: () => [] },
    hostProcesses?: HostProcessControl,
  ) =>
    createReconciliationService({
      runs,
      agentEvents,
      workspaces,
      worktrees,
      tasks,
      processes,
      commands,
      ...(hostProcesses === undefined ? {} : { hostProcesses }),
      events,
      runLogs: createRunLogStore({ paths }),
      resolveRuntime: (workspace) =>
        createWorkspaceRuntime(workspace.runtime, { hostPlatform: 'linux', paths }),
      now: () => '2026-09-10T01:00:00.000Z',
    })

  const createRunningRun = (worktreeId?: string, taskId?: string, pidIdentity?: string) => {
    const runDir = paths.runDir('run-1')
    if (!runDir.ok) throw new Error(runDir.error.message)
    const run = runs.create({
      id: 'run-1',
      workspaceId: 'workspace-1',
      agentType: 'codex',
      executionMode: 'attended',
      runDir: runDir.data,
      status: 'running',
      ...(worktreeId === undefined ? {} : { worktreeId }),
      ...(taskId === undefined ? {} : { taskId }),
    })
    if (!run.ok) throw new Error(run.error.message)
    const updated = runs.update('run-1', {
      processId: 'process-1',
      pid: 4242,
      ...(pidIdentity === undefined ? {} : { pidIdentity }),
    })
    if (!updated.ok || updated.data === null) throw new Error('could not update fixture Run')
    return updated.data
  }

  return {
    home,
    workspacePath,
    paths,
    runs,
    agentEvents,
    tasks,
    worktrees,
    events,
    commands,
    service,
    createRunningRun,
  }
}

describe('ReconciliationService (TASK-040)', () => {
  it('marks a DB-running Run interrupted when its registered process is dead, idempotently', async () => {
    const context = setup()
    const task = context.tasks.create({
      id: 'task-1',
      workspaceId: 'workspace-1',
      title: 'Recover me',
      status: 'running',
    })
    if (!task.ok) throw new Error(task.error.message)
    context.createRunningRun(undefined, 'task-1')
    const interrupted = vi.fn()
    context.events.subscribe('agent.interrupted', interrupted)
    const service = context.service()

    expect(await service.reconcile()).toMatchObject({
      ok: true,
      data: { scannedRuns: 1, interruptedRunIds: ['run-1'] },
    })
    expect(context.runs.getById('run-1')).toMatchObject({
      ok: true,
      data: { status: 'interrupted', error: { code: 'PROCESS_NOT_FOUND' } },
    })
    expect(interrupted).toHaveBeenCalledWith({ runId: 'run-1', reason: 'process_dead' })
    expect(context.agentEvents.listByRun('run-1')).toMatchObject({
      ok: true,
      data: [{ seq: 1, eventType: 'agent.interrupted' }],
    })
    expect(context.tasks.getById('task-1')).toMatchObject({
      ok: true,
      data: { status: 'blocked' },
    })

    expect(await service.reconcile()).toMatchObject({
      ok: true,
      data: { scannedRuns: 0, interruptedRunIds: [] },
    })
    expect(interrupted).toHaveBeenCalledOnce()
  })

  it('keeps a Run active only when process id and PID both match the registry', async () => {
    const context = setup()
    context.createRunningRun()
    const service = context.service({
      list: () => [
        {
          id: 'process-1',
          pid: 4242,
          agentRunId: 'run-1',
          startedAt: '2026-09-10T00:00:00.000Z',
        },
      ],
    })

    expect(await service.reconcile()).toMatchObject({
      ok: true,
      data: { scannedRuns: 1, interruptedRunIds: [] },
    })
    expect(context.runs.getById('run-1')).toMatchObject({ ok: true, data: { status: 'running' } })
  })

  it('recognizes a missing workspace and interrupts its active Run', async () => {
    const context = setup(false)
    context.createRunningRun()

    expect(await context.service().reconcile()).toMatchObject({
      ok: true,
      data: { missingWorkspaceIds: ['workspace-1'], interruptedRunIds: ['run-1'] },
    })
    expect(context.runs.getById('run-1')).toMatchObject({
      ok: true,
      data: { status: 'interrupted' },
    })
  })

  it('leaves a worktree untouched when the Git probe itself fails', async () => {
    const context = setup()
    const probePath = join(context.home, 'probe-worktree')
    mkdirSync(probePath)
    context.worktrees.create({
      id: 'worktree-probe',
      workspaceId: 'workspace-1',
      branch: 'agent/probe',
      baseBranch: 'main',
      path: probePath,
      state: 'ready',
      isolation: 'worktree',
    })
    // A probe failure (timeout, spawn error, WSL not ready at startup) says
    // nothing about the worktree — it must not be reclassified as orphaned.
    context.commands.run = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'COMMAND_TIMEOUT' as const, message: 'timed out', retryable: true },
    }))

    const result = await context.service().reconcile()

    expect(result).toMatchObject({ ok: true, data: { brokenWorktrees: [] } })
    expect(context.worktrees.getById('worktree-probe')).toMatchObject({
      ok: true,
      data: { state: 'ready' },
    })
  })

  it('terminates a surviving previous-instance process before interrupting the run (P0-2)', async () => {
    const context = setup()
    context.createRunningRun()
    const probe = vi.fn(async (): Promise<IpcResult<boolean>> => ({ ok: true, data: true }))
    const identity = vi.fn(async (): Promise<IpcResult<string | null>> => ({
      ok: true,
      data: null,
    }))
    const terminate = vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined }))
    const service = context.service({ list: () => [] }, { probe, identity, terminate })

    expect(await service.reconcile()).toMatchObject({
      ok: true,
      data: {
        scannedRuns: 1,
        interruptedRunIds: ['run-1'],
        terminatedSurvivorRunIds: ['run-1'],
        survivingRunIds: [],
      },
    })
    expect(probe).toHaveBeenCalledWith(4242)
    expect(terminate).toHaveBeenCalledWith(4242)
    expect(context.runs.getById('run-1')).toMatchObject({
      ok: true,
      data: { status: 'interrupted' },
    })
  })

  it('does not terminate anything when the recorded pid is dead (P0-2)', async () => {
    const context = setup()
    context.createRunningRun()
    const probe = vi.fn(async (): Promise<IpcResult<boolean>> => ({ ok: true, data: false }))
    const identity = vi.fn(async (): Promise<IpcResult<string | null>> => ({
      ok: true,
      data: null,
    }))
    const terminate = vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined }))
    const service = context.service({ list: () => [] }, { probe, identity, terminate })

    expect(await service.reconcile()).toMatchObject({
      ok: true,
      data: {
        interruptedRunIds: ['run-1'],
        terminatedSurvivorRunIds: [],
        survivingRunIds: [],
      },
    })
    expect(probe).toHaveBeenCalledWith(4242)
    expect(terminate).not.toHaveBeenCalled()
  })

  it('leaves the run active when a survivor cannot be terminated (P0-2)', async () => {
    const context = setup()
    context.createRunningRun()
    const probe = vi.fn(async (): Promise<IpcResult<boolean>> => ({ ok: true, data: true }))
    const identity = vi.fn(async (): Promise<IpcResult<string | null>> => ({
      ok: true,
      data: null,
    }))
    const terminate = vi.fn(async (): Promise<IpcResult<void>> => ({
      ok: false,
      error: { code: 'UNKNOWN', message: 'access denied', retryable: true },
    }))
    const interrupted = vi.fn()
    context.events.subscribe('agent.interrupted', interrupted)
    const service = context.service({ list: () => [] }, { probe, identity, terminate })

    expect(await service.reconcile()).toMatchObject({
      ok: true,
      data: {
        interruptedRunIds: [],
        terminatedSurvivorRunIds: [],
        survivingRunIds: ['run-1'],
      },
    })
    // No silent status flip while the Agent process is still writing.
    expect(context.runs.getById('run-1')).toMatchObject({ ok: true, data: { status: 'running' } })
    expect(interrupted).not.toHaveBeenCalled()
  })

  it('terminates a survivor whose identity token matches the recorded one', async () => {
    const context = setup()
    context.createRunningRun(undefined, undefined, 'start-token-A')
    const probe = vi.fn(async (): Promise<IpcResult<boolean>> => ({ ok: true, data: true }))
    const identity = vi.fn(async (): Promise<IpcResult<string | null>> => ({
      ok: true,
      data: 'start-token-A',
    }))
    const terminate = vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined }))
    const service = context.service({ list: () => [] }, { probe, identity, terminate })

    expect(await service.reconcile()).toMatchObject({
      ok: true,
      data: {
        interruptedRunIds: ['run-1'],
        terminatedSurvivorRunIds: ['run-1'],
        survivingRunIds: [],
      },
    })
    // The identity check replaces the bare probe when a token is on record.
    expect(probe).not.toHaveBeenCalled()
    expect(identity).toHaveBeenCalledWith(4242)
    expect(terminate).toHaveBeenCalledWith(4242)
  })

  it('never terminates a reused pid whose identity token does not match', async () => {
    const context = setup()
    context.createRunningRun(undefined, undefined, 'start-token-A')
    const probe = vi.fn(async (): Promise<IpcResult<boolean>> => ({ ok: true, data: true }))
    const identity = vi.fn(async (): Promise<IpcResult<string | null>> => ({
      ok: true,
      data: 'start-token-B',
    }))
    const terminate = vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined }))
    const service = context.service({ list: () => [] }, { probe, identity, terminate })

    // The recorded Agent is gone and pid 4242 now belongs to an unrelated
    // process: the run is interrupted, but that process is left alone.
    expect(await service.reconcile()).toMatchObject({
      ok: true,
      data: {
        interruptedRunIds: ['run-1'],
        terminatedSurvivorRunIds: [],
        survivingRunIds: [],
      },
    })
    expect(terminate).not.toHaveBeenCalled()
    expect(context.runs.getById('run-1')).toMatchObject({
      ok: true,
      data: { status: 'interrupted' },
    })
  })

  it('treats a run as dead when its pid is gone (identity returns null)', async () => {
    const context = setup()
    context.createRunningRun(undefined, undefined, 'start-token-A')
    const probe = vi.fn(async (): Promise<IpcResult<boolean>> => ({ ok: true, data: true }))
    const identity = vi.fn(async (): Promise<IpcResult<string | null>> => ({
      ok: true,
      data: null,
    }))
    const terminate = vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined }))
    const service = context.service({ list: () => [] }, { probe, identity, terminate })

    expect(await service.reconcile()).toMatchObject({
      ok: true,
      data: {
        interruptedRunIds: ['run-1'],
        terminatedSurvivorRunIds: [],
        survivingRunIds: [],
      },
    })
    expect(terminate).not.toHaveBeenCalled()
  })

  it('falls back to the liveness probe when the identity read fails', async () => {
    // Probe says alive: terminate under degraded verification — leaving a
    // live survivor unterminated while the run is marked interrupted would
    // open the resume double-write P0-2 forbids.
    const alive = setup()
    alive.createRunningRun(undefined, undefined, 'start-token-A')
    const aliveProbe = vi.fn(async (): Promise<IpcResult<boolean>> => ({ ok: true, data: true }))
    const failingIdentity = vi.fn(async (): Promise<IpcResult<string | null>> => ({
      ok: false,
      error: { code: 'UNKNOWN' as const, message: 'stat failed', retryable: true },
    }))
    const aliveTerminate = vi.fn(async (): Promise<IpcResult<void>> => ({
      ok: true,
      data: undefined,
    }))
    const aliveService = alive.service(
      { list: () => [] },
      { probe: aliveProbe, identity: failingIdentity, terminate: aliveTerminate },
    )
    expect(await aliveService.reconcile()).toMatchObject({
      ok: true,
      data: {
        interruptedRunIds: ['run-1'],
        terminatedSurvivorRunIds: ['run-1'],
        survivingRunIds: [],
      },
    })
    expect(aliveTerminate).toHaveBeenCalledWith(4242)

    // Probe says dead: nothing to terminate.
    const dead = setup()
    dead.createRunningRun(undefined, undefined, 'start-token-A')
    const deadProbe = vi.fn(async (): Promise<IpcResult<boolean>> => ({ ok: true, data: false }))
    const deadTerminate = vi.fn(async (): Promise<IpcResult<void>> => ({
      ok: true,
      data: undefined,
    }))
    const deadService = dead.service(
      { list: () => [] },
      { probe: deadProbe, identity: failingIdentity, terminate: deadTerminate },
    )
    expect(await deadService.reconcile()).toMatchObject({
      ok: true,
      data: {
        interruptedRunIds: ['run-1'],
        terminatedSurvivorRunIds: [],
        survivingRunIds: [],
      },
    })
    expect(deadTerminate).not.toHaveBeenCalled()
  })

  it('classifies absent and non-Git worktrees without mutating them twice', async () => {
    const context = setup()
    const absentPath = join(context.home, 'absent-worktree')
    const invalidPath = join(context.home, 'invalid-worktree')
    mkdirSync(invalidPath)
    context.worktrees.create({
      id: 'worktree-missing',
      workspaceId: 'workspace-1',
      branch: 'agent/missing',
      baseBranch: 'main',
      path: absentPath,
      state: 'ready',
      isolation: 'worktree',
    })
    context.worktrees.create({
      id: 'worktree-orphaned',
      workspaceId: 'workspace-1',
      branch: 'agent/orphaned',
      baseBranch: 'main',
      path: invalidPath,
      state: 'dirty',
      isolation: 'worktree',
    })
    const service = context.service()

    expect(await service.reconcile()).toMatchObject({
      ok: true,
      data: {
        brokenWorktrees: [
          { id: 'worktree-missing', state: 'missing' },
          { id: 'worktree-orphaned', state: 'orphaned' },
        ],
      },
    })
    const firstMissing = context.worktrees.getById('worktree-missing')
    const firstOrphaned = context.worktrees.getById('worktree-orphaned')
    expect(firstMissing).toMatchObject({ ok: true, data: { state: 'missing' } })
    expect(firstOrphaned).toMatchObject({ ok: true, data: { state: 'orphaned' } })

    await service.reconcile()
    expect(context.worktrees.getById('worktree-missing')).toEqual(firstMissing)
    expect(context.worktrees.getById('worktree-orphaned')).toEqual(firstOrphaned)
    expect(context.commands.run).toHaveBeenCalledOnce()
  })
})
