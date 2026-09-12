import Database from 'better-sqlite3'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { MemoryType } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import {
  createAgentRunRepository,
  createCriteriaRepository,
  createHandoffRepository,
  createMemoryRepository,
  createTaskRepository,
  createWorkspaceRepository,
} from '../db/repositories'
import { createTeskraPaths } from '../paths'
import { createPromptTemplateService } from '../prompts/prompt-template-service'
import {
  createContextBuilder,
  DEFAULT_CONTEXT_BUDGET_CHARS,
  type ContextBuilder,
} from './context-builder'
import { createMemoryManager } from './memory-manager'

const REPO_ROOT = '/repo/demo'

let connection: Database.Database
let builder: ContextBuilder

function setup(options?: { files?: Record<string, string> }) {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) {
    throw new Error(migrated.error.message)
  }
  connection
    .prepare(
      `INSERT INTO workspaces (id, name, runtime_kind, path, created_at, updated_at)
       VALUES ('ws-1', 'WS', 'windows', ?, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
    )
    .run(REPO_ROOT)
  connection
    .prepare(
      `INSERT INTO tasks (id, workspace_id, title, description, status, created_at, updated_at)
       VALUES ('task-1', 'ws-1', 'Add login', 'Implement the login page', 'ready',
               '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
    )
    .run()
  const paths = createTeskraPaths({ TESKRA_HOME: '/tmp/teskra-test-home' })
  const fileContents = new Map(Object.entries(options?.files ?? {}))
  const memoryDir = join(REPO_ROOT, '.teskra', 'memory')
  const memory = createMemoryManager({
    memory: createMemoryRepository(connection),
    workspaces: createWorkspaceRepository(connection),
    paths,
    createId: (() => {
      let next = 0
      return () => `m-${++next}`
    })(),
    now: () => '2026-09-11T00:00:00.000Z',
    listDir: (path) => {
      if (path !== memoryDir) {
        const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      return [...fileContents.keys()]
    },
    readFile: (path) => {
      const content = fileContents.get(path.slice(memoryDir.length + 1))
      if (content === undefined) {
        const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      return content
    },
    modifiedAt: () => '2026-09-10T00:00:00.000Z',
  })
  builder = createContextBuilder({
    tasks: createTaskRepository(connection),
    criteria: createCriteriaRepository(connection),
    runs: createAgentRunRepository(connection),
    handoffs: createHandoffRepository(connection),
    memory,
  })
  return { memory }
}

afterEach(() => {
  connection?.close()
})

function seedMemory(type: MemoryType, content: string) {
  connection
    .prepare(
      `INSERT INTO memories (id, workspace_id, type, content, source, created_at, updated_at)
       VALUES (lower(hex(randomblob(8))), 'ws-1', ?, ?, 'manual',
               '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
    )
    .run(type, content)
}

describe('ContextBuilder (TASK-068)', () => {
  it('packs everything within the default budget when it fits', () => {
    setup()
    seedMemory('architecture', 'Layered runtime.')
    const built = builder.buildContext({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      role: 'implementer',
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.data.budgetChars).toBe(DEFAULT_CONTEXT_BUDGET_CHARS)
    expect(built.data.totalChars).toBe(built.data.content.length)
    expect(built.data.totalChars).toBeLessThanOrEqual(built.data.budgetChars)
    expect(built.data.omittedCount).toBe(0)
    expect(built.data.parts.map((part) => part.key.split(':')[0])).toEqual([
      'task',
      'role',
      'memory',
    ])
    expect(built.data.content).toContain('## Task: Add login')
    expect(built.data.content).toContain('## Role\nimplementer')
    expect(built.data.content).toContain('### Memory · architecture\nLayered runtime.')
  })

  it('drops the lowest-priority memory when over budget and counts the omission', () => {
    setup()
    seedMemory('known_issue', 'Small but important pitfall.')
    seedMemory('summary', 'x'.repeat(1000))
    const built = builder.buildContext({ workspaceId: 'ws-1', budgetChars: 200 })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.data.totalChars).toBeLessThanOrEqual(200)
    expect(built.data.omittedCount).toBe(1)
    expect(built.data.content).toContain('Small but important pitfall.')
    expect(built.data.content).not.toContain('xxx')
  })

  it('omits even the task when the budget cannot hold it', () => {
    setup()
    const built = builder.buildContext({ workspaceId: 'ws-1', taskId: 'task-1', budgetChars: 10 })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.data.parts).toEqual([])
    expect(built.data.omittedCount).toBe(1)
    expect(built.data.content).toBe('')
  })

  it('degrades cleanly when the workspace has no memory', () => {
    setup()
    const built = builder.buildContext({ workspaceId: 'ws-1', taskId: 'task-1' })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.data.content).toContain('## Task: Add login')
    expect(built.data.content).not.toContain('### Memory')
    expect(built.data.omittedCount).toBe(0)
  })

  it('includes the confirmed criteria set and the latest handoff for the task', () => {
    setup()
    const criteria = createCriteriaRepository(connection)
    criteria.createSet({ id: 'set-1', taskId: 'task-1', version: 1 }, '2026-09-09T01:00:00.000Z')
    criteria.addCriterion(
      { id: 'c-1', criteriaSetId: 'set-1', ordinal: 1, description: 'Login works' },
      '2026-09-09T01:00:00.000Z',
    )
    criteria.confirmSet('set-1', '2026-09-09T02:00:00.000Z')
    // A draft v2 with different content must NOT win over the confirmed v1.
    criteria.createSet({ id: 'set-2', taskId: 'task-1', version: 2 }, '2026-09-09T03:00:00.000Z')
    criteria.addCriterion(
      { id: 'c-2', criteriaSetId: 'set-2', ordinal: 1, description: 'DRAFT — ignore' },
      '2026-09-09T03:00:00.000Z',
    )

    const runs = createAgentRunRepository(connection)
    const handoffs = createHandoffRepository(connection)
    runs.create(
      {
        id: 'run-old',
        workspaceId: 'ws-1',
        taskId: 'task-1',
        agentType: 'codex',
        executionMode: 'attended',
        runDir: '/runs/run-old',
        status: 'completed',
      },
      '2026-09-09T04:00:00.000Z',
    )
    runs.create(
      {
        id: 'run-new',
        workspaceId: 'ws-1',
        taskId: 'task-1',
        agentType: 'codex',
        executionMode: 'attended',
        runDir: '/runs/run-new',
        status: 'completed',
      },
      '2026-09-10T04:00:00.000Z',
    )
    handoffs.save(
      {
        id: 'h-old',
        runId: 'run-old',
        type: 'implementation',
        payload: { summary: 'old handoff' },
        parseStatus: 'degraded',
      },
      '2026-09-09T05:00:00.000Z',
    )
    handoffs.save(
      {
        id: 'h-new',
        runId: 'run-new',
        type: 'implementation',
        payload: { summary: 'new handoff' },
        parseStatus: 'degraded',
      },
      '2026-09-10T05:00:00.000Z',
    )

    const built = builder.buildContext({ workspaceId: 'ws-1', taskId: 'task-1' })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.data.content).toContain('## Acceptance Criteria\n- Login works')
    expect(built.data.content).not.toContain('DRAFT')
    expect(built.data.content).toContain('## Previous Handoff\nnew handoff')
    expect(built.data.content).not.toContain('old handoff')
  })

  it('fails for an unknown task', () => {
    setup()
    const built = builder.buildContext({ workspaceId: 'ws-1', taskId: 'task-missing' })
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.error.code).toBe('VALIDATION_FAILED')
  })

  it('merges repo-local memory files into the packed context', () => {
    setup({ files: { 'known-issues.md': 'Flaky CI runner.' } })
    const built = builder.buildContext({ workspaceId: 'ws-1' })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.data.content).toContain('### Memory · known_issue\nFlaky CI runner.')
  })

  it('feeds the packed memory section into prompt rendering ({{memory}} has real data)', () => {
    setup()
    seedMemory('convention', 'Use Conventional Commits.')
    const built = builder.buildContext({ workspaceId: 'ws-1' })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const prompts = createPromptTemplateService({
      paths: createTeskraPaths({ TESKRA_HOME: '/tmp/x' }),
    })
    const rendered = prompts.render({
      name: 'implement',
      context: {
        task: { title: 'Add login', description: '' },
        role: 'implementer',
        memory: built.data.content,
        env: { TESKRA_HANDOFF_PATH: '/h.json', TESKRA_ARTIFACT_DIR: '/a' },
      },
    })
    expect(rendered.ok).toBe(true)
    if (!rendered.ok) return
    expect(rendered.data.content).toContain('Use Conventional Commits.')
    expect(rendered.data.content).not.toContain('{{memory}}')
  })
})
