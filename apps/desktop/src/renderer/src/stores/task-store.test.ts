import type { Task, WorkbenchEventName, WorkbenchEvents } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createTaskStore, type TaskStoreBridge } from './task-store'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    workspaceId: 'workspace-1',
    title: 'Demo',
    status: 'draft',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

function setup() {
  let tasks = [task()]
  const handlers = new Map<WorkbenchEventName, Set<(payload: never) => void>>()
  const bridge: TaskStoreBridge = {
    task: {
      create: vi.fn(async (request) => {
        const created = task({ id: 'task-new', ...request })
        tasks = [created, ...tasks]
        return { ok: true as const, data: created }
      }),
      update: vi.fn(async (request) => {
        const current = tasks.find(({ id }) => id === request.id) ?? task({ id: request.id })
        const updated = { ...current, ...request }
        tasks = tasks.map((item) => (item.id === request.id ? updated : item))
        return { ok: true as const, data: updated }
      }),
      archive: vi.fn(async ({ id, archived }) => ({
        ok: true as const,
        data: task({ id, archivedAt: archived ? '2026-09-10T01:00:00.000Z' : undefined }),
      })),
      delete: vi.fn(async ({ id }) => {
        tasks = tasks.filter((item) => item.id !== id)
        return { ok: true as const, data: true }
      }),
      get: vi.fn(async ({ id }) => ({
        ok: true as const,
        data: tasks.find((item) => item.id === id) ?? null,
      })),
      list: vi.fn(async ({ workspaceId }) => ({
        ok: true as const,
        data: tasks.filter((item) => item.workspaceId === workspaceId),
      })),
    },
    events: {
      subscribe: vi.fn((name, handler) => {
        const listeners = handlers.get(name) ?? new Set()
        listeners.add(handler as (payload: never) => void)
        handlers.set(name, listeners)
        return () => listeners.delete(handler as (payload: never) => void)
      }),
    },
  }
  return {
    bridge,
    replace(next: Task) {
      tasks = [next, ...tasks.filter(({ id }) => id !== next.id)]
    },
    emit<Name extends WorkbenchEventName>(name: Name, payload: WorkbenchEvents[Name]) {
      for (const handler of handlers.get(name) ?? []) handler(payload as never)
    },
  }
}

describe('Task store', () => {
  it('synchronizes Task lifecycle events for one Workspace', async () => {
    const context = setup()
    const store = createTaskStore(() => context.bridge)
    const stop = store.getState().startSynchronization('workspace-1')
    await vi.waitFor(() => expect(store.getState().tasks).toHaveLength(1))

    context.replace(task({ status: 'running' }))
    context.emit('task.updated', { taskId: 'task-1' })
    await vi.waitFor(() => expect(store.getState().tasks[0]?.status).toBe('running'))
    stop()
  })

  it('creates, edits, archives, and deletes through the typed bridge', async () => {
    const context = setup()
    const store = createTaskStore(() => context.bridge)
    await store.getState().synchronize('workspace-1')

    expect(
      await store.getState().createTask({ workspaceId: 'workspace-1', title: 'New Task' }),
    ).toMatchObject({ id: 'task-new' })
    expect(await store.getState().updateTask({ id: 'task-new', status: 'ready' })).toBe(true)
    expect(await store.getState().archiveTask('task-new', true)).toBe(true)
    expect(store.getState().tasks.some(({ id }) => id === 'task-new')).toBe(false)
    expect(await store.getState().deleteTask('task-1')).toBe(true)
    expect(store.getState().tasks).toEqual([])
  })
})
