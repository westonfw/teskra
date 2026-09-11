import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MEMORY_TYPES } from '@teskra/contracts'

import { createTeskraPaths } from '../paths'
import { migrateDatabase } from '../db/migrations'
import { createMemoryRepository } from '../db/repositories/memory-repository'
import { createWorkspaceRepository } from '../db/repositories/workspace-repository'
import { createMemoryManager, parseMemoryFile, type MemoryManager } from './memory-manager'

const REPO_ROOT = '/repo/demo'
const MEMORY_DIR = join(REPO_ROOT, '.teskra', 'memory')

let connection: Database.Database

function setup(options?: {
  files?: Record<string, string>
  createId?: () => string
}): MemoryManager {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
  const workspaces = createWorkspaceRepository(connection)
  const insertWorkspace = (id: string, path: string) => {
    connection
      .prepare(
        `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
         VALUES (?, ?, 'windows', ?, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
      )
      .run(id, id, path)
  }
  insertWorkspace('ws-1', REPO_ROOT)
  insertWorkspace('ws-2', '/repo/other')
  const files = options?.files ?? {}
  const fileContents = new Map(Object.entries(files))
  return createMemoryManager({
    memory: createMemoryRepository(connection),
    workspaces,
    paths: createTeskraPaths({ TESKRA_HOME: '/tmp/teskra-test-home' }),
    createId: options?.createId,
    now: () => '2026-09-11T00:00:00.000Z',
    listDir: (path) => {
      if (path !== MEMORY_DIR) {
        const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      return [...fileContents.keys()]
    },
    readFile: (path) => {
      const name = path.slice(MEMORY_DIR.length + 1)
      const content = fileContents.get(name)
      if (content === undefined) {
        const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      return content
    },
    modifiedAt: () => '2026-09-10T00:00:00.000Z',
  })
}

afterEach(() => {
  connection?.close()
})

describe('parseMemoryFile', () => {
  it('reads the type from frontmatter', () => {
    const parsed = parseMemoryFile(
      'anything.md',
      '---\ntype: known_issue\n---\nFlaky test on CI.\n',
    )
    expect(parsed.type).toBe('known_issue')
    expect(parsed.content).toBe('Flaky test on CI.')
  })

  it('falls back to the plan §45 file-name convention', () => {
    expect(parseMemoryFile('architecture.md', 'Layers').type).toBe('architecture')
    expect(parseMemoryFile('conventions.md', 'Naming').type).toBe('convention')
    expect(parseMemoryFile('decisions.md', 'ADR').type).toBe('decision')
    expect(parseMemoryFile('commands.md', 'npm test').type).toBe('command')
    expect(parseMemoryFile('known-issues.md', 'Bug').type).toBe('known_issue')
    expect(parseMemoryFile('preferences.md', 'Style').type).toBe('preference')
    expect(parseMemoryFile('random-notes.md', 'Misc').type).toBe('summary')
  })

  it('ignores an invalid frontmatter type', () => {
    const parsed = parseMemoryFile('commands.md', '---\ntype: dream\n---\nnpm test')
    expect(parsed.type).toBe('command')
  })
})

describe('MemoryManager', () => {
  it('creates, reads, updates and deletes a memory bound to a workspace', () => {
    const manager = setup({ createId: () => 'm-1' })
    const created = manager.create({
      workspaceId: 'ws-1',
      type: 'convention',
      content: 'Use Conventional Commits',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data).toMatchObject({
      id: 'm-1',
      workspaceId: 'ws-1',
      type: 'convention',
      source: 'manual',
      updatedAt: '2026-09-11T00:00:00.000Z',
    })
    expect(manager.get({ id: 'm-1' })).toEqual(created)

    const updated = manager.update({ id: 'm-1', content: 'v2', type: 'decision' })
    expect(updated.ok && updated.data?.content).toBe('v2')
    expect(updated.ok && updated.data?.type).toBe('decision')

    expect(manager.delete({ id: 'm-1' })).toEqual({ ok: true, data: true })
    expect(manager.get({ id: 'm-1' })).toEqual({ ok: true, data: null })
  })

  it('isolates memories per workspace', () => {
    let next = 0
    const manager = setup({ createId: () => `m-${++next}` })
    manager.create({ workspaceId: 'ws-1', type: 'summary', content: 'one' })
    manager.create({ workspaceId: 'ws-2', type: 'summary', content: 'two' })

    const list = manager.list({ workspaceId: 'ws-1' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect(list.data).toHaveLength(1)
    expect(list.data[0]?.content).toBe('one')
  })

  it('fails list/create for an unknown workspace', () => {
    const manager = setup()
    const listed = manager.list({ workspaceId: 'ws-missing' })
    expect(listed.ok).toBe(false)
    if (listed.ok) return
    expect(listed.error.code).toBe('WORKSPACE_NOT_FOUND')
    const created = manager.create({ workspaceId: 'ws-missing', type: 'summary', content: 'x' })
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.error.code).toBe('WORKSPACE_NOT_FOUND')
  })

  it('refuses to store content that looks like a secret', () => {
    const manager = setup()
    const created = manager.create({
      workspaceId: 'ws-1',
      type: 'command',
      content: 'curl -H "Authorization: Bearer ghp_0123456789abcdef" https://api.github.com',
    })
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.error.code).toBe('VALIDATION_FAILED')

    const clean = manager.create({ workspaceId: 'ws-1', type: 'summary', content: 'clean' })
    expect(clean.ok).toBe(true)
    if (!clean.ok) return
    const updated = manager.update({ id: clean.data.id, content: 'sk-abcdefghijklmnop' })
    expect(updated.ok).toBe(false)
    if (updated.ok) return
    expect(updated.error.code).toBe('VALIDATION_FAILED')
  })

  it('merges repo-local .teskra/memory files as read-only records', () => {
    const manager = setup({
      files: {
        'architecture.md': '---\ntype: architecture\n---\nLayered runtime.',
        'notes.md': 'Plain summary file.',
        'commands.md': 'npm run test:unit',
        'leak.md': 'token ghp_0123456789abcdef',
        'empty.md': '   ',
        'ignored.txt': 'not markdown',
      },
    })
    const listed = manager.list({ workspaceId: 'ws-1' })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const byId = new Map(listed.data.map((record) => [record.id, record]))
    expect([...byId.keys()].sort()).toEqual([
      'file:architecture.md',
      'file:commands.md',
      'file:notes.md',
    ])
    expect(byId.get('file:architecture.md')).toMatchObject({
      workspaceId: 'ws-1',
      type: 'architecture',
      content: 'Layered runtime.',
      source: `file:${join(MEMORY_DIR, 'architecture.md')}`,
      updatedAt: '2026-09-10T00:00:00.000Z',
    })
    expect(byId.get('file:notes.md')?.type).toBe('summary')
    expect(byId.get('file:commands.md')?.type).toBe('command')

    const filtered = manager.list({ workspaceId: 'ws-1', type: 'command' })
    expect(filtered.ok && filtered.data.map((record) => record.id)).toEqual(['file:commands.md'])
  })

  it('rejects update/delete of repo-local file memories', () => {
    const manager = setup({ files: { 'architecture.md': 'Layered runtime.' } })
    const updated = manager.update({ id: 'file:architecture.md', content: 'changed' })
    expect(updated.ok).toBe(false)
    if (updated.ok) return
    expect(updated.error.code).toBe('VALIDATION_FAILED')
    const deleted = manager.delete({ id: 'file:architecture.md' })
    expect(deleted.ok).toBe(false)
    if (deleted.ok) return
    expect(deleted.error.code).toBe('VALIDATION_FAILED')
  })

  it('degrades to database rows when the memory directory is absent', () => {
    const manager = setup()
    const created = manager.create({ workspaceId: 'ws-1', type: 'summary', content: 'db only' })
    expect(created.ok).toBe(true)
    const listed = manager.list({ workspaceId: 'ws-1' })
    expect(listed.ok && listed.data.map((record) => record.content)).toEqual(['db only'])
  })
})

describe('Memory type enum vs plan §139.1 SQL', () => {
  it('matches the type list documented in 004_artifacts_memory.sql', () => {
    const migration = readFileSync(
      join(__dirname, '../db/migrations/004_artifacts_memory.sql'),
      'utf8',
    )
    const comment = /--\s*architecture\|convention\|decision\|command\|known_issue\|preference\|summary/
    expect(migration).toMatch(comment)
    for (const type of MEMORY_TYPES) {
      expect(migration).toContain(type)
    }
    expect(MEMORY_TYPES).toEqual([
      'architecture',
      'convention',
      'decision',
      'command',
      'known_issue',
      'preference',
      'summary',
    ])
  })
})
