import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IpcResult, WorkbenchEvents } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import { createWorkspaceRepository, createWorktreeRepository } from '../db/repositories'
import type { Worktree } from '../db/repositories/worktree-repository'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createTeskraPaths } from '../paths'
import {
  createCommandRunner,
  type CommandRequest,
  type CommandRunner,
} from '../process/command-runner'
import { createWorkspaceRuntime, type WorkspaceRuntime } from '../workspace/runtime'
import { createWorktreeManager, mergeExcludeEntries, worktreeBranchName } from './worktree-manager'

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface Fixture {
  readonly manager: ReturnType<typeof createWorktreeManager>
  readonly worktrees: ReturnType<typeof createWorktreeRepository>
  readonly events: EventBus<WorkbenchEvents>
  readonly commands: CommandRunner
  readonly repoDir: string
  readonly dataRoot: string
}

/** Real git repository + in-memory SQLite + native-posix runtime (WSL dev host). */
async function setup(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-worktree-'))
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
  const workspace = workspaces.create({
    id: 'workspace-1',
    name: 'Worktree fixture',
    runtime: { kind: 'wsl', distro: 'Ubuntu' },
    path: repoDir,
  })
  if (!workspace.ok) throw new Error(workspace.error.message)

  const paths = createTeskraPaths({ TESKRA_HOME: dataRoot })
  const events = createEventBus<WorkbenchEvents>()
  const manager = createWorktreeManager({
    commands,
    workspaces,
    worktrees,
    events,
    resolveRuntime: (candidate) =>
      createWorkspaceRuntime(candidate.runtime, { hostPlatform: 'linux', paths }),
  })
  return { manager, worktrees, events, commands, repoDir, dataRoot }
}

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

describe('WorktreeManager naming (TASK-043 / ADR-0003)', () => {
  it('pins the branch format with and without a task', () => {
    // Fixed choice: without a taskId the branch falls back to agent/<runId>,
    // keeping the agent/ prefix consistent.
    expect(
      worktreeBranchName({
        workspaceId: 'ws',
        runId: 'run-9',
        taskId: 'task-1',
        agentId: 'codex',
      }),
    ).toBe('agent/task-1/codex/run-9')
    expect(worktreeBranchName({ workspaceId: 'ws', runId: 'run-9' })).toBe('agent/run-9')
  })

  it('mergeExcludeEntries appends missing entries exactly once', () => {
    const once = mergeExcludeEntries('# existing\n.teskra/handoff/\n')
    expect(once).toBe('# existing\n.teskra/handoff/\n.teskra/artifacts/\n')
    expect(mergeExcludeEntries(once)).toBe(once)
    expect(mergeExcludeEntries('')).toBe('.teskra/handoff/\n.teskra/artifacts/\n')
  })
})

describe('WorktreeManager (TASK-043)', () => {
  it('creates an isolated branch + worktree under resolveDataRoot() and excludes runtime artifacts', async () => {
    const fixture = await setup()
    const changed = vi.fn()
    fixture.events.subscribe('git.changed', changed)

    const created = requireOk(
      await fixture.manager.create({
        workspaceId: 'workspace-1',
        runId: 'run-1',
        taskId: 'task-1',
        agentId: 'codex',
      }),
    )
    expect(created).toMatchObject({
      workspaceId: 'workspace-1',
      runId: 'run-1',
      branch: 'agent/task-1/codex/run-1',
      baseBranch: 'main',
      state: 'ready',
      isolation: 'worktree',
    })
    const expectedPath = join(fixture.dataRoot, 'worktrees', 'workspace-1', 'run-1')
    expect(created.path).toBe(expectedPath)
    expect(existsSync(expectedPath)).toBe(true)
    expect(changed).toHaveBeenCalledWith({ workspaceId: 'workspace-1' })

    // Independent branch, checked out in the worktree only.
    const branches = await fixture.commands.run({
      command: 'git',
      args: ['branch', '--format=%(refname)'],
      cwd: fixture.repoDir,
      timeoutMs: 15_000,
    })
    expect(requireOk(branches).stdout).toContain('refs/heads/agent/task-1/codex/run-1')
    const head = await fixture.commands.run({
      command: 'git',
      args: ['branch', '--show-current'],
      cwd: created.path,
      timeoutMs: 15_000,
    })
    expect(requireOk(head).stdout.trim()).toBe('agent/task-1/codex/run-1')
    const mainHead = await fixture.commands.run({
      command: 'git',
      args: ['branch', '--show-current'],
      cwd: fixture.repoDir,
      timeoutMs: 15_000,
    })
    expect(requireOk(mainHead).stdout.trim()).toBe('main')

    // .git/info/exclude (not .gitignore) gained the artifact entries (ADR-0004).
    const exclude = readFileSync(join(fixture.repoDir, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('.teskra/handoff/')
    expect(exclude).toContain('.teskra/artifacts/')
    expect(existsSync(join(fixture.repoDir, '.gitignore'))).toBe(false)

    // Second create: exclude stays idempotent (no duplicated lines).
    requireOk(await fixture.manager.create({ workspaceId: 'workspace-1', runId: 'run-2' }))
    const after = readFileSync(join(fixture.repoDir, '.git', 'info', 'exclude'), 'utf8')
    expect(after).toBe(exclude)
    expect(after.split('\n').filter((line) => line === '.teskra/handoff/')).toHaveLength(1)
  })

  it('rejects a duplicate runId and invalid path segments', async () => {
    const fixture = await setup()
    requireOk(await fixture.manager.create({ workspaceId: 'workspace-1', runId: 'run-1' }))
    const duplicate = await fixture.manager.create({ workspaceId: 'workspace-1', runId: 'run-1' })
    expect(duplicate).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    const invalid = await fixture.manager.create({
      workspaceId: 'workspace-1',
      runId: '../escape',
    })
    expect(invalid).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    const missing = await fixture.manager.create({ workspaceId: 'nope', runId: 'run-2' })
    expect(missing).toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } })
  })

  it('lists worktrees by workspace and state', async () => {
    const fixture = await setup()
    requireOk(await fixture.manager.create({ workspaceId: 'workspace-1', runId: 'run-1' }))
    requireOk(await fixture.manager.create({ workspaceId: 'workspace-1', runId: 'run-2' }))

    const all = requireOk(await fixture.manager.list({ workspaceId: 'workspace-1' }))
    expect(all.map((worktree) => worktree.runId).sort()).toEqual(['run-1', 'run-2'])
    const ready = requireOk(
      await fixture.manager.list({ workspaceId: 'workspace-1', state: 'ready' }),
    )
    expect(ready).toHaveLength(2)
    expect(
      requireOk(await fixture.manager.list({ workspaceId: 'workspace-1', state: 'discarded' })),
    ).toEqual([])
    const unknown = await fixture.manager.list({ workspaceId: 'nope' })
    expect(unknown).toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } })
  })

  it('validate flips ready → dirty → missing → orphaned as the filesystem changes', async () => {
    const fixture = await setup()
    const created = requireOk(
      await fixture.manager.create({ workspaceId: 'workspace-1', runId: 'run-1' }),
    )

    expect(
      requireOk(await fixture.manager.validate({ worktreeId: created.id })),
    ).toMatchObject({ state: 'ready' })

    writeFileSync(join(created.path, 'dirty.txt'), 'agent output\n')
    expect(
      requireOk(await fixture.manager.validate({ worktreeId: created.id })),
    ).toMatchObject({ state: 'dirty' })

    rmSync(created.path, { recursive: true, force: true })
    expect(
      requireOk(await fixture.manager.validate({ worktreeId: created.id })),
    ).toMatchObject({ state: 'missing' })

    // A plain directory that is not a git worktree is orphaned.
    const orphanDir = join(fixture.dataRoot, 'worktrees', 'workspace-1', 'run-orphan')
    mkdirSync(orphanDir, { recursive: true })
    const orphan = fixture.worktrees.create({
      id: 'worktree-orphan',
      workspaceId: 'workspace-1',
      runId: 'run-orphan',
      branch: 'agent/run-orphan',
      baseBranch: 'main',
      path: orphanDir,
      isolation: 'worktree',
      state: 'ready',
    })
    if (!orphan.ok) throw new Error(orphan.error.message)
    expect(
      requireOk(await fixture.manager.validate({ worktreeId: orphan.data.id })),
    ).toMatchObject({ state: 'orphaned' })

    const unknown = await fixture.manager.validate({ worktreeId: 'nope' })
    expect(unknown).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('remove runs git worktree remove and transitions to discarded (idempotent)', async () => {
    const fixture = await setup()
    const created = requireOk(
      await fixture.manager.create({ workspaceId: 'workspace-1', runId: 'run-1' }),
    )
    writeFileSync(join(created.path, 'uncommitted.txt'), 'discarded with the worktree\n')

    const removed = requireOk(await fixture.manager.remove({ worktreeId: created.id }))
    expect(removed).toMatchObject({ state: 'discarded' })
    expect(removed.discardedAt).toBeDefined()
    expect(existsSync(created.path)).toBe(false)
    const listed = await fixture.commands.run({
      command: 'git',
      args: ['worktree', 'list', '--porcelain'],
      cwd: fixture.repoDir,
      timeoutMs: 15_000,
    })
    expect(requireOk(listed).stdout).not.toContain(created.path)
    // The branch survives removal — it holds the Agent's committed work.
    const branches = await fixture.commands.run({
      command: 'git',
      args: ['branch', '--format=%(refname)'],
      cwd: fixture.repoDir,
      timeoutMs: 15_000,
    })
    expect(requireOk(branches).stdout).toContain('refs/heads/agent/run-1')

    const again = requireOk(await fixture.manager.remove({ worktreeId: created.id }))
    expect(again.state).toBe('discarded')
  })

  it('remove prunes administrative files when the directory is already gone', async () => {
    const fixture = await setup()
    const created = requireOk(
      await fixture.manager.create({ workspaceId: 'workspace-1', runId: 'run-1' }),
    )
    rmSync(created.path, { recursive: true, force: true })
    const removed = requireOk(await fixture.manager.remove({ worktreeId: created.id }))
    expect(removed.state).toBe('discarded')
    const listed = await fixture.commands.run({
      command: 'git',
      args: ['worktree', 'list', '--porcelain'],
      cwd: fixture.repoDir,
      timeoutMs: 15_000,
    })
    expect(requireOk(listed).stdout).not.toContain(created.path)
  })

  it('two agents in two worktrees write without polluting each other', async () => {
    const fixture = await setup()
    const codex = requireOk(
      await fixture.manager.create({
        workspaceId: 'workspace-1',
        runId: 'run-codex',
        taskId: 'task-7',
        agentId: 'codex',
      }),
    )
    const claude = requireOk(
      await fixture.manager.create({
        workspaceId: 'workspace-1',
        runId: 'run-claude',
        taskId: 'task-7',
        agentId: 'claude',
      }),
    )
    expect(codex.branch).toBe('agent/task-7/codex/run-codex')
    expect(claude.branch).toBe('agent/task-7/claude/run-claude')

    const statusIn = async (cwd: string) => {
      const result = await fixture.commands.run({
        command: 'git',
        args: ['status', '--porcelain'],
        cwd,
        timeoutMs: 15_000,
      })
      return requireOk(result).stdout.trim()
    }

    writeFileSync(join(codex.path, 'codex-output.txt'), 'from codex\n')
    writeFileSync(join(claude.path, 'claude-output.txt'), 'from claude\n')
    expect(await statusIn(codex.path)).toBe('?? codex-output.txt')
    expect(await statusIn(claude.path)).toBe('?? claude-output.txt')
    expect(await statusIn(fixture.repoDir)).toBe('')
    expect(existsSync(join(codex.path, 'claude-output.txt'))).toBe(false)
    expect(existsSync(join(claude.path, 'codex-output.txt'))).toBe(false)

    // A commit on one branch is invisible from the other.
    await fixture.commands.run({
      command: 'git',
      args: ['add', '--all'],
      cwd: codex.path,
      timeoutMs: 15_000,
    })
    await fixture.commands.run({
      command: 'git',
      args: ['commit', '--message', 'agent(codex): task-7 work'],
      cwd: codex.path,
      timeoutMs: 15_000,
    })
    const claudeLog = await fixture.commands.run({
      command: 'git',
      args: ['log', '--format=%s'],
      cwd: claude.path,
      timeoutMs: 15_000,
    })
    expect(requireOk(claudeLog).stdout).not.toContain('agent(codex): task-7 work')
    expect(await statusIn(codex.path)).toBe('')
    expect(await statusIn(claude.path)).toBe('?? claude-output.txt')
  })

  it('fails cleanly when the repository has a detached HEAD and no baseBranch', async () => {
    const fixture = await setup()
    await fixture.commands.run({
      command: 'git',
      args: ['checkout', '--detach', 'HEAD'],
      cwd: fixture.repoDir,
      timeoutMs: 15_000,
    })
    const detached = await fixture.manager.create({ workspaceId: 'workspace-1', runId: 'run-1' })
    expect(detached).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    const explicit = requireOk(
      await fixture.manager.create({
        workspaceId: 'workspace-1',
        runId: 'run-1',
        baseBranch: 'main',
      }),
    )
    expect(explicit.baseBranch).toBe('main')
  })

  it('places WSL worktrees under the runtime resolveDataRoot(), never the host paths module', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'teskra-worktree-wsl-'))
    directories.push(directory)
    const database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    const migrated = migrateDatabase(database)
    if (!migrated.ok) throw new Error(migrated.error.message)
    databases.push(database)
    const workspaces = createWorkspaceRepository(database)
    const worktrees = createWorktreeRepository(database)
    const workspace = workspaces.create({
      id: 'workspace-wsl',
      name: 'WSL workspace',
      runtime: { kind: 'wsl', distro: 'Ubuntu' },
      path: '/home/wsluser/repo',
    })
    if (!workspace.ok) throw new Error(workspace.error.message)

    // Simulated Windows-host WSL runtime: the data root is WSL-side (ADR-0003)
    // and the host filesystem cannot probe it.
    const runtime: WorkspaceRuntime = {
      ref: { kind: 'wsl', distro: 'Ubuntu' },
      hostNative: false,
      resolveCommand: (command, args = [], cwd) => ({
        executable: 'wsl.exe',
        args: ['-d', 'Ubuntu', ...(cwd === undefined ? [] : ['--cd', cwd]), command, ...args],
      }),
      resolveTerminal: () => ({ ok: true, data: { command: 'bash', args: ['-l'] } }),
      resolveCwd: (path) => path,
      resolveHostPath: (path) => ({
        ok: true,
        data: `\\\\wsl.localhost\\Ubuntu\\${path.replaceAll('/', '\\')}`,
      }),
      resolveDataRoot: () => '/home/wsluser/.teskra',
      validate: () => ({ ok: true, data: { kind: 'wsl', hostNative: false } }),
    }
    const requests: CommandRequest[] = []
    const commands: CommandRunner = {
      async run(request) {
        requests.push(request)
        const stdout = request.args?.includes('--show-current') === true ? 'main\n' : ''
        return { ok: true, data: { stdout, stderr: '', exitCode: 0 } }
      },
    }
    const manager = createWorktreeManager({
      commands,
      workspaces,
      worktrees,
      events: createEventBus<WorkbenchEvents>(),
      resolveRuntime: () => ({ ok: true, data: runtime }),
    })

    const created = requireOk(
      await manager.create({ workspaceId: 'workspace-wsl', runId: 'run-wsl' }),
    )
    expect(created.path).toBe('/home/wsluser/.teskra/worktrees/workspace-wsl/run-wsl')
    expect(created.branch).toBe('agent/run-wsl')

    const add = requests.find((request) => request.args?.[0] === 'worktree')
    expect(add).toBeDefined()
    expect(add?.args).toEqual([
      'worktree',
      'add',
      '-b',
      'agent/run-wsl',
      '/home/wsluser/.teskra/worktrees/workspace-wsl/run-wsl',
      'main',
    ])
    // Every command ran inside the WSL runtime, not on the host.
    for (const request of requests) expect(request.runtime).toBe(runtime)
    // .git/info/exclude was appended through a shell inside the runtime.
    const exclude = requests.find((request) => request.command === 'bash')
    expect(exclude?.args?.[1]).toContain('.teskra/handoff/')
    expect(exclude?.args?.[1]).toContain('.teskra/artifacts/')
    expect(exclude?.cwd).toBe('/home/wsluser/repo')
  })
})

describe('WorktreeManager exclude merge (unit)', () => {
  it('handles missing trailing newline and repeated merges', () => {
    const merged = mergeExcludeEntries('node_modules')
    expect(merged).toBe('node_modules\n.teskra/handoff/\n.teskra/artifacts/\n')
    expect(mergeExcludeEntries(merged)).toBe(merged)
  })

  it('keeps types honest: repository Worktree matches the contracts schema', () => {
    const sample: Worktree = {
      id: 'wt',
      workspaceId: 'ws',
      runId: 'run',
      branch: 'agent/run',
      baseBranch: 'main',
      path: '/data/worktrees/ws/run',
      state: 'ready',
      isolation: 'worktree',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    }
    expect(sample.state).toBe('ready')
  })
})
