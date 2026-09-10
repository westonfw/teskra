import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkbenchEvents } from '@teskra/contracts'

import { migrateDatabase } from '../db/migrations'
import {
  createAgentRunRepository,
  createTaskRepository,
  createWorkspaceRepository,
} from '../db/repositories'
import { createEventBus, type EventBus } from '../events/event-bus'
import { createTaskManager, type TaskManager } from './task-manager'

let connection: Database.Database
let events: EventBus<WorkbenchEvents>
let manager: TaskManager
let agentRuns: ReturnType<typeof createAgentRunRepository>

beforeEach(() => {
  connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  const migrated = migrateDatabase(connection)
  if (!migrated.ok) throw new Error(migrated.error.message)
  const workspaces = createWorkspaceRepository(connection)
  const workspace = workspaces.create({
    id: 'workspace-1',
    name: 'Demo',
    runtime: { kind: 'windows' },
    path: 'C:\\repo',
  })
  if (!workspace.ok) throw new Error(workspace.error.message)
  events = createEventBus<WorkbenchEvents>()
  agentRuns = createAgentRunRepository(connection)
  manager = createTaskManager({
    tasks: createTaskRepository(connection),
    workspaces,
    events,
    createTaskId: () => 'task-1',
    now: () => '2026-09-10T00:00:00.000Z',
  })
})

afterEach(() => connection.close())

describe('TaskManager (TASK-032)', () => {
  it('creates, edits, archives, restores, and deletes a workspace-bound Task', () => {
    const createdEvent = vi.fn()
    const updatedEvent = vi.fn()
    events.subscribe('task.created', createdEvent)
    events.subscribe('task.updated', updatedEvent)

    expect(
      manager.create({
        workspaceId: 'workspace-1',
        title: 'Ship Tasks',
        description: 'Implement the domain',
      }),
    ).toMatchObject({
      ok: true,
      data: { id: 'task-1', workspaceId: 'workspace-1', status: 'draft' },
    })
    expect(createdEvent).toHaveBeenCalledWith({ taskId: 'task-1', workspaceId: 'workspace-1' })

    expect(
      manager.update({ id: 'task-1', title: 'Ship Task CRUD', status: 'ready' }),
    ).toMatchObject({
      ok: true,
      data: { title: 'Ship Task CRUD', status: 'ready' },
    })
    expect(manager.archive({ id: 'task-1', archived: true })).toMatchObject({
      ok: true,
      data: { archivedAt: '2026-09-10T00:00:00.000Z' },
    })
    expect(manager.list({ workspaceId: 'workspace-1' })).toEqual({ ok: true, data: [] })
    expect(manager.archive({ id: 'task-1', archived: false })).toMatchObject({
      ok: true,
      data: { archivedAt: undefined },
    })
    expect(updatedEvent).toHaveBeenCalledTimes(3)
    for (const id of ['run-1', 'run-2']) {
      expect(
        agentRuns.create({
          id,
          workspaceId: 'workspace-1',
          taskId: 'task-1',
          agentType: 'codex',
          executionMode: 'attended',
          runDir: `/runs/${id}`,
        }).ok,
      ).toBe(true)
    }
    expect(agentRuns.listByTask('task-1')).toMatchObject({
      ok: true,
      data: [{ taskId: 'task-1' }, { taskId: 'task-1' }],
    })
    expect(manager.delete('task-1')).toEqual({ ok: true, data: true })
    expect(manager.get('task-1')).toEqual({ ok: true, data: null })
    expect(agentRuns.getById('run-1')).toMatchObject({ ok: true, data: { taskId: undefined } })
  })

  it('rejects Tasks for an unknown Workspace and reports missing updates', () => {
    expect(manager.create({ workspaceId: 'missing', title: 'No owner' })).toMatchObject({
      ok: false,
      error: { code: 'WORKSPACE_NOT_FOUND' },
    })
    expect(manager.update({ id: 'missing', status: 'ready' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' },
    })
  })
})
