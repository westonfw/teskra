import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../db/migrations'
import { createWorkspaceRepository } from '../db/repositories'
import { createEventBus } from '../events/event-bus'
import {
  createCommandRunner,
  type CommandRequest,
  type CommandRunner,
} from '../process/command-runner'
import { createWorkspaceRuntime } from '../workspace/runtime'
import { createDiffService, UNTRACKED_STAT_CONCURRENCY, type DiffService } from './diff-service'
import { createGitManager, type GitManager } from './git-manager'

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

interface Fixture {
  readonly directory: string
  readonly commands: CommandRunner
  readonly git: GitManager
  readonly service: DiffService
  readonly gitSpawnCount: () => number
  readonly resetGitSpawnCount: () => void
  readonly runGit: (...args: string[]) => Promise<void>
}

async function setup(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'teskra-diff-'))
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

  let spawns = 0
  const countingCommands: CommandRunner = {
    run: (request: CommandRequest) => {
      if (request.command === 'git') spawns += 1
      return commands.run(request)
    },
  }

  const database = new Database(':memory:')
  databases.push(database)
  database.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(database)
  if (!migrated.ok) throw new Error(migrated.error.message)
  const workspaces = createWorkspaceRepository(database)
  workspaces.create({
    id: 'workspace-1',
    name: 'Diff fixture',
    runtime: { kind: 'wsl' },
    path: directory,
  })
  const git = createGitManager({
    commands: countingCommands,
    workspaces,
    events: createEventBus(),
    resolveRuntime: (workspace) =>
      createWorkspaceRuntime(workspace.runtime, { hostPlatform: 'linux' }),
  })
  return {
    directory,
    commands,
    git,
    service: createDiffService({ git }),
    gitSpawnCount: () => spawns,
    resetGitSpawnCount: () => {
      spawns = 0
    },
    runGit,
  }
}

async function commitAll(fixture: Fixture, message: string): Promise<void> {
  await fixture.runGit('add', '--all')
  await fixture.runGit('commit', '--message', message)
}

describe('DiffService (TASK-036)', () => {
  it('lists added, modified, deleted, and renamed files with batch line stats and no patches', async () => {
    const fixture = await setup()
    writeFileSync(join(fixture.directory, 'modified.txt'), 'before\n')
    writeFileSync(join(fixture.directory, 'deleted.txt'), 'delete me\n')
    writeFileSync(join(fixture.directory, 'rename-old.txt'), 'rename me\n')
    await commitAll(fixture, 'fixture')

    writeFileSync(join(fixture.directory, 'modified.txt'), 'after\nsecond line\n')
    unlinkSync(join(fixture.directory, 'deleted.txt'))
    renameSync(join(fixture.directory, 'rename-old.txt'), join(fixture.directory, 'rename-new.txt'))
    writeFileSync(join(fixture.directory, 'added.txt'), 'new file\n')
    mkdirSync(join(fixture.directory, 'added-dir'))
    writeFileSync(join(fixture.directory, 'added-dir', 'nested.txt'), 'nested new\n')

    const beforeStage = await fixture.service.get('workspace-1')
    if (!beforeStage.ok) throw new Error(beforeStage.error.message)
    // P1-5: the list carries stats only — patch bodies are lazy per file.
    for (const file of beforeStage.data.files) {
      expect(file).not.toHaveProperty('patch')
    }
    expect(beforeStage.data.files).toContainEqual({
      path: 'added.txt',
      status: 'added',
      additions: 1,
      deletions: 0,
    })
    // An untracked directory must surface its files individually — a collapsed
    // `? added-dir/` entry cannot be diffed and would hide the agent's output.
    expect(beforeStage.data.files).toContainEqual({
      path: 'added-dir/nested.txt',
      status: 'added',
      additions: 1,
      deletions: 0,
    })
    expect(beforeStage.data.files).toContainEqual({
      path: 'modified.txt',
      status: 'modified',
      additions: 2,
      deletions: 1,
    })
    expect(beforeStage.data.files).toContainEqual({
      path: 'deleted.txt',
      status: 'deleted',
      additions: 0,
      deletions: 1,
    })

    await fixture.runGit('add', '--all')
    const result = await fixture.service.get('workspace-1')
    if (!result.ok) throw new Error(result.error.message)
    expect(Object.fromEntries(result.data.files.map((file) => [file.path, file.status]))).toEqual({
      'added-dir/nested.txt': 'added',
      'added.txt': 'added',
      'deleted.txt': 'deleted',
      'modified.txt': 'modified',
      'rename-new.txt': 'renamed',
    })
  })

  it('gathers stats for many tracked files with a constant number of git spawns', async () => {
    const fixture = await setup()
    for (let index = 0; index < 50; index += 1) {
      writeFileSync(join(fixture.directory, `file-${String(index)}.txt`), 'one\n')
    }
    await commitAll(fixture, 'fixture')
    for (let index = 0; index < 50; index += 1) {
      writeFileSync(join(fixture.directory, `file-${String(index)}.txt`), 'one\ntwo\n')
    }

    fixture.resetGitSpawnCount()
    const result = await fixture.service.get('workspace-1')
    if (!result.ok) throw new Error(result.error.message)
    expect(result.data.files).toHaveLength(50)
    expect(result.data.files.every((file) => file.additions === 1 && file.deletions === 0)).toBe(
      true,
    )
    // P1-5: status + staged numstat + unstaged numstat — never one spawn per
    // file (the old implementation would have used 100+ here).
    expect(fixture.gitSpawnCount()).toBeLessThanOrEqual(3)
  })

  it('lazy-loads the patch of a single tracked file, staged and unstaged combined', async () => {
    const fixture = await setup()
    writeFileSync(join(fixture.directory, 'tracked.txt'), 'before\n')
    await commitAll(fixture, 'fixture')

    writeFileSync(join(fixture.directory, 'tracked.txt'), 'staged\n')
    await fixture.runGit('add', 'tracked.txt')
    writeFileSync(join(fixture.directory, 'tracked.txt'), 'staged\nunstaged\n')

    const patch = await fixture.service.getFilePatch('workspace-1', 'tracked.txt')
    if (!patch.ok) throw new Error(patch.error.message)
    expect(patch.data.patch).toContain('+staged')
    expect(patch.data.patch).toContain('+unstaged')

    // A file that is no longer changed yields an empty patch, not an error.
    const unchanged = await fixture.service.getFilePatch('workspace-1', 'no-such-file.txt')
    expect(unchanged).toEqual({ ok: true, data: { patch: '' } })
  })

  it('lazy-loads the patch of an untracked file', async () => {
    const fixture = await setup()
    writeFileSync(join(fixture.directory, 'seed.txt'), 'seed\n')
    await commitAll(fixture, 'fixture')
    mkdirSync(join(fixture.directory, 'added-dir'))
    writeFileSync(join(fixture.directory, 'added-dir', 'nested.txt'), 'nested new\n')

    const patch = await fixture.service.getFilePatch('workspace-1', 'added-dir/nested.txt')
    if (!patch.ok) throw new Error(patch.error.message)
    expect(patch.data.patch).toContain('+nested new')
  })
})

describe('DiffService untracked fan-out', () => {
  it('bounds concurrent untracked stat probes instead of forking one git per file', async () => {
    const paths = Array.from({ length: 40 }, (_, index) => `untracked-${String(index)}.txt`)
    let inFlight = 0
    let maxInFlight = 0
    const service = createDiffService({
      git: {
        status: () =>
          Promise.resolve({
            ok: true,
            data: {
              ahead: 0,
              behind: 0,
              clean: false,
              entries: paths.map((path) => ({ path, code: '??' })),
            },
          }),
        diffNumstat: () => Promise.resolve({ ok: true, data: [] }),
        untrackedNumstat: (_workspaceId, path) => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          return new Promise((resolve) => {
            setTimeout(() => {
              inFlight -= 1
              resolve({ ok: true, data: { path, additions: 1, deletions: 0 } })
            }, 5)
          })
        },
        diff: () => Promise.resolve({ ok: true, data: { patch: '' } }),
        untrackedDiff: () => Promise.resolve({ ok: true, data: { patch: '' } }),
      },
    })

    const result = await service.get('workspace-1')
    if (!result.ok) throw new Error(result.error.message)
    expect(result.data.files).toHaveLength(paths.length)
    expect(result.data.files.every((file) => file.additions === 1)).toBe(true)
    // Parallel, but never one process per file.
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(UNTRACKED_STAT_CONCURRENCY)
  })
})
