import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkbenchEvents } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import { createWorkspaceRepository } from '../db/repositories'
import { createEventBus } from '../events/event-bus'
import { createCommandRunner, type CommandRunner } from '../process/command-runner'
import { createWorkspaceRuntime, type WorkspaceRuntime } from '../workspace/runtime'
import { createGitManager } from './git-manager'

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function repository() {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(database)
  if (!migrated.ok) throw new Error(migrated.error.message)
  databases.push(database)
  return createWorkspaceRepository(database)
}

describe('GitManager (TASK-035)', () => {
  it('supports status, branch, diff, log, and commit in a WSL/native repository', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'teskra-git-'))
    directories.push(directory)
    const commands = createCommandRunner({ hostPlatform: 'linux' })
    const initialized = await commands.run({
      command: 'git',
      args: ['init', '--initial-branch=main'],
      cwd: directory,
      timeoutMs: 15_000,
    })
    if (!initialized.ok || initialized.data.exitCode !== 0) throw new Error('git init failed')
    for (const [key, value] of [
      ['user.name', 'Teskra Test'],
      ['user.email', 'teskra@example.invalid'],
    ] as const) {
      await commands.run({
        command: 'git',
        args: ['config', key, value],
        cwd: directory,
        timeoutMs: 15_000,
      })
    }
    const workspaces = repository()
    const workspace = workspaces.create({
      id: 'workspace-1',
      name: 'Git fixture',
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      path: directory,
    })
    if (!workspace.ok) throw new Error(workspace.error.message)
    const events = createEventBus<WorkbenchEvents>()
    const changed = vi.fn()
    const openPath = vi.fn(async () => '')
    events.subscribe('git.changed', changed)
    const manager = createGitManager({
      commands,
      workspaces,
      events,
      resolveRuntime: (candidate) =>
        createWorkspaceRuntime(candidate.runtime, { hostPlatform: 'linux' }),
      openPath,
    })

    writeFileSync(join(directory, 'hello.txt'), 'hello\n')
    mkdirSync(join(directory, 'node_modules', 'ignored-package'), { recursive: true })
    writeFileSync(join(directory, 'node_modules', 'ignored-package', 'index.js'), 'ignored\n')
    expect(await manager.status('workspace-1')).toMatchObject({
      ok: true,
      data: { branch: 'main', clean: false, entries: [{ code: '??', path: 'hello.txt' }] },
    })
    expect(await manager.openFile({ workspaceId: 'workspace-1', path: 'hello.txt' })).toEqual({
      ok: true,
      data: undefined,
    })
    expect(openPath).toHaveBeenCalledWith(join(directory, 'hello.txt'))
    const committed = await manager.commit({
      workspaceId: 'workspace-1',
      message: 'feat: initial',
      all: true,
    })
    expect(committed).toMatchObject({ ok: true, data: { hash: expect.any(String) } })
    expect(changed).toHaveBeenCalledWith({ workspaceId: 'workspace-1' })
    expect(await manager.branch('workspace-1')).toMatchObject({
      ok: true,
      data: { current: 'main', detached: false, branches: ['main'] },
    })

    writeFileSync(join(directory, 'hello.txt'), 'hello\nworld\n')
    expect(await manager.status('workspace-1')).toMatchObject({
      ok: true,
      data: { clean: false, entries: [{ code: '.M', path: 'hello.txt' }] },
    })
    const diff = await manager.diff({ workspaceId: 'workspace-1', path: 'hello.txt' })
    expect(diff.ok && diff.data.patch).toContain('+world')
    expect(await manager.log({ workspaceId: 'workspace-1', limit: 5 })).toMatchObject({
      ok: true,
      data: [{ subject: 'feat: initial', author: 'Teskra Test' }],
    })
  })

  it('uses a Windows WorkspaceRuntime and returns sanitized structured Git errors', async () => {
    const workspaces = repository()
    const workspace = workspaces.create({
      id: 'workspace-1',
      name: 'Windows repo',
      runtime: { kind: 'windows' },
      path: 'C:\\repo',
    })
    if (!workspace.ok) throw new Error(workspace.error.message)
    const runtime: WorkspaceRuntime = {
      ref: { kind: 'windows' },
      hostNative: true,
      resolveCommand: (command, args = [], cwd) => ({ executable: command, args, cwd }),
      resolveTerminal: () => ({
        ok: true,
        data: { command: 'powershell.exe', args: [] },
      }),
      resolveCwd: (path) => path,
      resolveHostPath: (path) => ({ ok: true, data: path }),
      resolveDataRoot: () => 'C:\\data',
      validate: () => ({ ok: true, data: { kind: 'windows', hostNative: true } }),
    }
    const commands: CommandRunner = {
      run: vi.fn(async () => ({
        ok: true as const,
        data: { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 },
      })),
    }
    const manager = createGitManager({
      commands,
      workspaces,
      events: createEventBus(),
      resolveRuntime: () => ({ ok: true, data: runtime }),
    })

    const result = await manager.status('workspace-1')
    expect(commands.run).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'git', cwd: 'C:\\repo', runtime }),
    )
    expect(result).toEqual({
      ok: false,
      error: { code: 'UNKNOWN', message: 'Git status failed.', retryable: true },
    })
    expect(result).not.toHaveProperty('error.detail')
  })

  it('rejects diff paths that can escape the workspace', async () => {
    const workspaces = repository()
    workspaces.create({
      id: 'workspace-1',
      name: 'Repo',
      runtime: { kind: 'wsl' },
      path: '/repo',
    })
    const manager = createGitManager({
      commands: { run: vi.fn() },
      workspaces,
      events: createEventBus(),
      resolveRuntime: () => {
        throw new Error('must not resolve')
      },
    })

    expect(await manager.diff({ workspaceId: 'workspace-1', path: '../secret' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
    expect(await manager.openFile({ workspaceId: 'workspace-1', path: '../secret' })).toMatchObject(
      {
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      },
    )
  })
})
