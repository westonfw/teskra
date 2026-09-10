import type {
  CreateTaskRequest,
  IpcResult,
  PublicAppError,
  Task,
  UpdateTaskRequest,
  WorkbenchEvents,
} from '@teskra/contracts'
import { create } from 'zustand'

export interface TaskStoreBridge {
  readonly task: {
    create(request: CreateTaskRequest): Promise<IpcResult<Task>>
    update(request: UpdateTaskRequest): Promise<IpcResult<Task>>
    archive(request: { id: string; archived: boolean }): Promise<IpcResult<Task>>
    delete(request: { id: string }): Promise<IpcResult<boolean>>
    get(request: { id: string }): Promise<IpcResult<Task | null>>
    list(request: { workspaceId: string; includeArchived?: boolean }): Promise<IpcResult<Task[]>>
  }
  readonly events: {
    subscribe<Name extends 'task.created' | 'task.updated'>(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}

interface TaskState {
  readonly tasks: readonly Task[]
  readonly selectedId?: string
  readonly loading: boolean
  readonly saving: boolean
  readonly error?: PublicAppError
  startSynchronization(workspaceId: string): () => void
  synchronize(workspaceId: string): Promise<void>
  createTask(request: CreateTaskRequest): Promise<Task | undefined>
  updateTask(request: UpdateTaskRequest): Promise<boolean>
  archiveTask(id: string, archived: boolean): Promise<boolean>
  deleteTask(id: string): Promise<boolean>
  selectTask(id?: string): void
  clearError(): void
}

const transportError: PublicAppError = {
  code: 'UNKNOWN',
  message: 'Teskra could not reach the Task service.',
  retryable: true,
}

function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function upsertTask(tasks: readonly Task[], task: Task): Task[] {
  return sortTasks([task, ...tasks.filter(({ id }) => id !== task.id)])
}

export function createTaskStore(getBridge: () => TaskStoreBridge) {
  let synchronizationGeneration = 0
  let loadGeneration = 0

  return create<TaskState>((set, get) => ({
    tasks: [],
    loading: false,
    saving: false,

    startSynchronization(workspaceId) {
      const generation = ++synchronizationGeneration
      const bridge = getBridge()
      const refresh = ({ taskId }: { taskId: string }): void => {
        void bridge.task
          .get({ id: taskId })
          .then((result) => {
            if (generation !== synchronizationGeneration) return
            if (!result.ok) {
              set({ error: result.error })
            } else {
              const refreshed = result.data
              if (refreshed !== null && refreshed.workspaceId === workspaceId) {
                set((state) => {
                  if (refreshed.archivedAt === undefined) {
                    return { tasks: upsertTask(state.tasks, refreshed) }
                  }
                  const tasks = state.tasks.filter(({ id }) => id !== refreshed.id)
                  return {
                    tasks,
                    selectedId: state.selectedId === refreshed.id ? tasks[0]?.id : state.selectedId,
                  }
                })
              }
            }
          })
          .catch(() => {
            if (generation === synchronizationGeneration) set({ error: transportError })
          })
      }
      const stops = [
        bridge.events.subscribe('task.created', refresh),
        bridge.events.subscribe('task.updated', refresh),
      ]
      void get().synchronize(workspaceId)
      return () => {
        if (generation === synchronizationGeneration) synchronizationGeneration += 1
        for (const stop of stops) stop()
      }
    },

    async synchronize(workspaceId) {
      const generation = ++loadGeneration
      set({ loading: true, error: undefined })
      try {
        const result = await getBridge().task.list({ workspaceId })
        if (generation !== loadGeneration) return
        if (!result.ok) {
          set({ loading: false, error: result.error })
          return
        }
        set((state) => ({
          tasks: sortTasks(result.data),
          selectedId:
            result.data.find(({ id }) => id === state.selectedId)?.id ?? result.data[0]?.id,
          loading: false,
        }))
      } catch {
        if (generation === loadGeneration) set({ loading: false, error: transportError })
      }
    },

    async createTask(request) {
      set({ saving: true, error: undefined })
      try {
        const result = await getBridge().task.create(request)
        if (!result.ok) {
          set({ saving: false, error: result.error })
          return undefined
        }
        set((state) => ({
          tasks: upsertTask(state.tasks, result.data),
          selectedId: result.data.id,
          saving: false,
        }))
        return result.data
      } catch {
        set({ saving: false, error: transportError })
        return undefined
      }
    },

    async updateTask(request) {
      set({ saving: true, error: undefined })
      try {
        const result = await getBridge().task.update(request)
        if (!result.ok) {
          set({ saving: false, error: result.error })
          return false
        }
        set((state) => ({ tasks: upsertTask(state.tasks, result.data), saving: false }))
        return true
      } catch {
        set({ saving: false, error: transportError })
        return false
      }
    },

    async archiveTask(id, archived) {
      set({ saving: true, error: undefined })
      try {
        const result = await getBridge().task.archive({ id, archived })
        if (!result.ok) {
          set({ saving: false, error: result.error })
          return false
        }
        set((state) => {
          const tasks = archived
            ? state.tasks.filter((task) => task.id !== id)
            : upsertTask(state.tasks, result.data)
          return {
            tasks,
            selectedId: state.selectedId === id ? tasks[0]?.id : state.selectedId,
            saving: false,
          }
        })
        return true
      } catch {
        set({ saving: false, error: transportError })
        return false
      }
    },

    async deleteTask(id) {
      set({ saving: true, error: undefined })
      try {
        const result = await getBridge().task.delete({ id })
        if (!result.ok) {
          set({ saving: false, error: result.error })
          return false
        }
        set((state) => {
          const tasks = state.tasks.filter((task) => task.id !== id)
          return {
            tasks,
            selectedId: state.selectedId === id ? tasks[0]?.id : state.selectedId,
            saving: false,
          }
        })
        return result.data
      } catch {
        set({ saving: false, error: transportError })
        return false
      }
    },

    selectTask(selectedId) {
      set({ selectedId })
    },

    clearError() {
      set({ error: undefined })
    },
  }))
}

export const useTaskStore = createTaskStore(() => window.teskra)
