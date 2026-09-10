import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { migrateDatabase } from '../db/migrations'
import { createWorkspaceRepository } from '../db/repositories'
import { createEventBus } from '../events/event-bus'
import { createCommandRunner } from '../process/command-runner'
import { createWorkspaceRuntime } from '../workspace/runtime'
import { createDiffService } from './diff-service'
import { createGitManager } from './git-manager'

const databases: Database.Database[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('DiffService (TASK-036)', () => {
  it('recognizes added, modified, deleted, and renamed files with line stats and patches', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'teskra-diff-'))
    directories.push(directory)
    const commands = createCommandRunner({ hostPlatform: 'linux' })
    for (const args of [
      ['init', '--initial-branch=main'],
      ['config', 'user.name', 'Teskra Test'],
      ['config', 'user.email', 'teskra@example.invalid'],
    ]) {
      const result = await commands.run({ command: 'git', args, cwd: directory, timeoutMs: 15_000 })
      if (!result.ok || result.data.exitCode !== 0) throw new Error('Git fixture setup failed')
    }
    writeFileSync(join(directory, 'modified.txt'), 'before\n')
    writeFileSync(join(directory, 'deleted.txt'), 'delete me\n')
    writeFileSync(join(directory, 'rename-old.txt'), 'rename me\n')
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
      commands,
      workspaces,
      events: createEventBus(),
      resolveRuntime: (workspace) =>
        createWorkspaceRuntime(workspace.runtime, { hostPlatform: 'linux' }),
    })
    const service = createDiffService({ git })

    writeFileSync(join(directory, 'modified.txt'), 'after\nsecond line\n')
    unlinkSync(join(directory, 'deleted.txt'))
    renameSync(join(directory, 'rename-old.txt'), join(directory, 'rename-new.txt'))
    writeFileSync(join(directory, 'added.txt'), 'new file\n')

    const beforeStage = await service.get('workspace-1')
    expect(beforeStage.ok && beforeStage.data.files).toContainEqual(
      expect.objectContaining({ path: 'added.txt', status: 'added', additions: 1 }),
    )

    await commands.run({
      command: 'git',
      args: ['add', '--all'],
      cwd: directory,
      timeoutMs: 15_000,
    })
    const result = await service.get('workspace-1')
    if (!result.ok) throw new Error(result.error.message)
    expect(Object.fromEntries(result.data.files.map((file) => [file.path, file.status]))).toEqual({
      'added.txt': 'added',
      'deleted.txt': 'deleted',
      'modified.txt': 'modified',
      'rename-new.txt': 'renamed',
    })
    expect(result.data.files.find(({ path }) => path === 'modified.txt')).toMatchObject({
      additions: 2,
      deletions: 1,
      patch: expect.stringContaining('+second line'),
    })
  })
})
