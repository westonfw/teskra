import { randomUUID } from 'node:crypto'

import type {
  ArchiveTaskRequest,
  CreateTaskRequest,
  IpcResult,
  ListTasksRequest,
  Task,
  UpdateTaskRequest,
  WorkbenchEvents,
} from '@teskra/contracts'

import type { TaskRepository } from '../db/repositories/task-repository'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import type { EventBus } from '../events/event-bus'
import { type InternalAppError, toPublicError } from '../errors'

export interface TaskManager {
  create(request: CreateTaskRequest): IpcResult<Task>
  update(request: UpdateTaskRequest): IpcResult<Task>
  archive(request: ArchiveTaskRequest): IpcResult<Task>
  delete(id: string): IpcResult<boolean>
  get(id: string): IpcResult<Task | null>
  list(request: ListTasksRequest): IpcResult<Task[]>
}

export interface TaskManagerDeps {
  readonly tasks: TaskRepository
  readonly workspaces: WorkspaceRepository
  readonly events: EventBus<WorkbenchEvents>
  readonly createTaskId?: () => string
  readonly now?: () => string
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function missing<T>(kind: 'Task' | 'Workspace', id: string): IpcResult<T> {
  return fail({
    code: kind === 'Workspace' ? 'WORKSPACE_NOT_FOUND' : 'VALIDATION_FAILED',
    message: `${kind} "${id}" was not found.`,
    retryable: false,
    detail: `TaskManager could not resolve ${kind.toLowerCase()} id=${JSON.stringify(id)}`,
  })
}

/** TASK-032 domain service; Task persistence remains exclusively in its Repository. */
export function createTaskManager(deps: TaskManagerDeps): TaskManager {
  const createTaskId = deps.createTaskId ?? randomUUID
  const now = deps.now ?? (() => new Date().toISOString())

  const requireUpdated = (result: IpcResult<Task | null>, id: string): IpcResult<Task> => {
    if (!result.ok) return result
    return result.data === null ? missing('Task', id) : { ok: true, data: result.data }
  }

  return {
    create(request) {
      const workspace = deps.workspaces.getById(request.workspaceId)
      if (!workspace.ok) return workspace
      if (workspace.data === null) return missing('Workspace', request.workspaceId)
      const created = deps.tasks.create(
        {
          id: createTaskId(),
          workspaceId: workspace.data.id,
          title: request.title,
          ...(request.description === undefined ? {} : { description: request.description }),
          ...(request.status === undefined ? {} : { status: request.status }),
        },
        now(),
      )
      if (created.ok) {
        deps.events.emit('task.created', {
          taskId: created.data.id,
          workspaceId: created.data.workspaceId,
        })
      }
      return created
    },

    update(request) {
      const updated = requireUpdated(
        deps.tasks.update(
          request.id,
          {
            ...(request.title === undefined ? {} : { title: request.title }),
            ...(request.description === undefined ? {} : { description: request.description }),
            ...(request.status === undefined ? {} : { status: request.status }),
          },
          now(),
        ),
        request.id,
      )
      if (updated.ok) deps.events.emit('task.updated', { taskId: request.id })
      return updated
    },

    archive({ id, archived }) {
      const updated = requireUpdated(
        deps.tasks.update(id, { archivedAt: archived ? now() : null }, now()),
        id,
      )
      if (updated.ok) deps.events.emit('task.updated', { taskId: id })
      return updated
    },

    delete(id) {
      return deps.tasks.delete(id)
    },

    get: (id) => deps.tasks.getById(id),

    list(request) {
      const workspace = deps.workspaces.getById(request.workspaceId)
      if (!workspace.ok) return workspace
      if (workspace.data === null) return missing('Workspace', request.workspaceId)
      return deps.tasks.listByWorkspace(request.workspaceId, {
        ...(request.status === undefined ? {} : { status: request.status }),
        ...(request.includeArchived === undefined
          ? {}
          : { includeArchived: request.includeArchived }),
      })
    },
  }
}
