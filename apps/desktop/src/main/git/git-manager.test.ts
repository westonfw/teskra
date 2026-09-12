import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IpcResult, WorkbenchEvents } from '@teskra/contracts'

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
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
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
    const commands = createCommandRunner()
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
      // Keep checkouts byte-identical on every host: Git for Windows defaults
      // to core.autocrlf=true, which would rewrite LF to CRLF on checkout.
      ['core.autocrlf', 'false'],
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
    // openFile builds the runtime-side path with POSIX separators
    // (resolveCwd of the native-posix runtime normalizes with node:path.posix);
    // on a Windows host the temp directory keeps its backslashes, so the
    // expected value is the same template join, not node:path.join.
    expect(openPath).toHaveBeenCalledWith(`${directory}/hello.txt`)
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

  it('reports a detached HEAD as detached, not as a pseudo-branch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'teskra-git-detached-'))
    directories.push(directory)
    const commands = createCommandRunner()
    for (const args of [
      ['init', '--initial-branch=main'],
      ['config', 'user.name', 'Teskra Test'],
      ['config', 'user.email', 'teskra@example.invalid'],
    ]) {
      const result = await commands.run({ command: 'git', args, cwd: directory, timeoutMs: 15_000 })
      if (!result.ok || result.data.exitCode !== 0) throw new Error('Git fixture setup failed')
    }
    writeFileSync(join(directory, 'a.txt'), 'a\n')
    await commands.run({
      command: 'git',
      args: ['add', '--all'],
      cwd: directory,
      timeoutMs: 15_000,
    })
    await commands.run({
      command: 'git',
      args: ['commit', '--message', 'fixture'],
      cwd: directory,
      timeoutMs: 15_000,
    })
    const workspaces = repository()
    workspaces.create({
      id: 'workspace-1',
      name: 'Detached fixture',
      runtime: { kind: 'wsl' },
      path: directory,
    })
    const manager = createGitManager({
      commands,
      workspaces,
      events: createEventBus(),
      resolveRuntime: (candidate) =>
        createWorkspaceRuntime(candidate.runtime, { hostPlatform: 'linux' }),
    })

    expect(await manager.branch('workspace-1')).toMatchObject({
      ok: true,
      data: { current: 'main', detached: false, branches: ['main'] },
    })

    const detached = await commands.run({
      command: 'git',
      args: ['checkout', '--detach', 'HEAD'],
      cwd: directory,
      timeoutMs: 15_000,
    })
    if (!detached.ok || detached.data.exitCode !== 0)
      throw new Error('git checkout --detach failed')

    const result = await manager.branch('workspace-1')
    expect(result).toMatchObject({
      ok: true,
      data: { current: undefined, detached: true, branches: ['main'] },
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

  it('deduplicates in-flight status calls for the same workspace', async () => {
    const workspaces = repository()
    workspaces.create({
      id: 'workspace-1',
      name: 'Repo',
      runtime: { kind: 'wsl' },
      path: '/repo',
    })
    let resolveCommand:
      | ((
          result: IpcResult<{
            stdout: string
            stderr: string
            exitCode: number
          }>,
        ) => void)
      | undefined
    const commandResult = new Promise<
      IpcResult<{
        stdout: string
        stderr: string
        exitCode: number
      }>
    >((resolve) => {
      resolveCommand = resolve
    })
    const commands: CommandRunner = { run: vi.fn(() => commandResult) }
    const manager = createGitManager({
      commands,
      workspaces,
      events: createEventBus(),
      resolveRuntime: (candidate) =>
        createWorkspaceRuntime(candidate.runtime, { hostPlatform: 'linux' }),
    })

    const first = manager.status('workspace-1')
    const second = manager.status('workspace-1')
    expect(commands.run).toHaveBeenCalledOnce()
    resolveCommand?.({
      ok: true,
      data: { stdout: '# branch.head main\0', stderr: '', exitCode: 0 },
    })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, data: { branch: 'main', ahead: 0, behind: 0, clean: true, entries: [] } },
      { ok: true, data: { branch: 'main', ahead: 0, behind: 0, clean: true, entries: [] } },
    ])
  })

  it('passes a timeout to CommandRunner without cancelling an Agent Run', async () => {
    const workspaces = repository()
    workspaces.create({
      id: 'workspace-1',
      name: 'Repo',
      runtime: { kind: 'wsl' },
      path: '/repo',
    })
    const events = createEventBus<WorkbenchEvents>()
    const agentCancelled = vi.fn()
    events.subscribe('agent.cancelled', agentCancelled)
    const commands: CommandRunner = {
      run: vi.fn(async () => ({
        ok: false as const,
        error: {
          code: 'COMMAND_TIMEOUT' as const,
          message: 'Command timed out.',
          retryable: true,
        },
      })),
    }
    const manager = createGitManager({
      commands,
      workspaces,
      events,
      resolveRuntime: (candidate) =>
        createWorkspaceRuntime(candidate.runtime, { hostPlatform: 'linux' }),
    })

    expect(await manager.status('workspace-1')).toMatchObject({
      ok: false,
      error: { code: 'COMMAND_TIMEOUT' },
    })
    expect(commands.run).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 15_000 }))
    expect(agentCancelled).not.toHaveBeenCalled()
  })

  it('parses batched numstat: renames keyed by new path, binaries as zero stats', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'teskra-git-numstat-'))
    directories.push(directory)
    const commands = createCommandRunner()
    const runGit = async (...args: string[]): Promise<void> => {
      const result = await commands.run({ command: 'git', args, cwd: directory, timeoutMs: 15_000 })
      if (!result.ok || result.data.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')} failed`)
      }
    }
    await runGit('init', '--initial-branch=main')
    await runGit('config', 'user.name', 'Teskra Test')
    await runGit('config', 'user.email', 'teskra@example.invalid')
    writeFileSync(join(directory, 'old-name.txt'), 'a\nb\nc\n')
    writeFileSync(join(directory, 'binary.dat'), Buffer.from([0, 1, 2, 3, 0, 255]))
    await runGit('add', '--all')
    await runGit('commit', '--message', 'fixture')
    const workspaces = repository()
    workspaces.create({
      id: 'workspace-1',
      name: 'Numstat fixture',
      runtime: { kind: 'wsl' },
      path: directory,
    })
    const manager = createGitManager({
      commands,
      workspaces,
      events: createEventBus(),
      resolveRuntime: (candidate) =>
        createWorkspaceRuntime(candidate.runtime, { hostPlatform: 'linux' }),
    })

    await runGit('mv', 'old-name.txt', 'new-name.txt')
    writeFileSync(join(directory, 'new-name.txt'), 'a\nb\nc\nd\n')
    writeFileSync(join(directory, 'binary.dat'), Buffer.from([0, 1, 2, 3, 0, 254, 253]))

    const staged = await manager.diffNumstat({ workspaceId: 'workspace-1', staged: true })
    if (!staged.ok) throw new Error(staged.error.message)
    // A staged rename is one entry keyed by the NEW path (status porcelain
    // v2 reports the same path for its R entries), never a phantom old path.
    expect(staged.data).toEqual([{ path: 'new-name.txt', additions: 0, deletions: 0 }])

    const unstaged = await manager.diffNumstat({ workspaceId: 'workspace-1' })
    if (!unstaged.ok) throw new Error(unstaged.error.message)
    expect(unstaged.data).toContainEqual({ path: 'new-name.txt', additions: 1, deletions: 0 })
    // Binary files show `-` in numstat output and surface as zero stats.
    expect(unstaged.data).toContainEqual({ path: 'binary.dat', additions: 0, deletions: 0 })

    writeFileSync(join(directory, 'untracked.txt'), 'n1\nn2\n')
    const untracked = await manager.untrackedNumstat('workspace-1', 'untracked.txt')
    expect(untracked).toEqual({
      ok: true,
      data: { path: 'untracked.txt', additions: 2, deletions: 0 },
    })
    expect(await manager.untrackedNumstat('workspace-1', '../escape')).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
  })
})
