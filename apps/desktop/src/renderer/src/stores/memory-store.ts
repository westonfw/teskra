import type {
  CreateMemoryRequest,
  IpcResult,
  ListMemoriesRequest,
  Memory,
  MemoryIdRequest,
  PublicAppError,
  UpdateMemoryRequest,
} from '@teskra/contracts'
import { create } from 'zustand'

export interface MemoryStoreBridge {
  readonly memory: {
    list(request: ListMemoriesRequest): Promise<IpcResult<Memory[]>>
    create(request: CreateMemoryRequest): Promise<IpcResult<Memory>>
    update(request: UpdateMemoryRequest): Promise<IpcResult<Memory | null>>
    delete(request: MemoryIdRequest): Promise<IpcResult<boolean>>
  }
}

interface MemoryState {
  readonly workspaceId?: string
  readonly memories: readonly Memory[]
  readonly loading: boolean
  readonly saving: boolean
  readonly error?: PublicAppError
  synchronize(workspaceId: string): Promise<void>
  create(request: CreateMemoryRequest): Promise<boolean>
  update(request: UpdateMemoryRequest): Promise<boolean>
  remove(id: string): Promise<boolean>
  clearError(): void
}

const transportError: PublicAppError = {
  code: 'UNKNOWN',
  message: 'Teskra could not reach the Memory service.',
  retryable: true,
}

/** Repo-local memories (`.teskra/memory/*.md`) are read-only in the UI. */
export function isRepoLocalMemory(memory: Memory): boolean {
  return memory.source?.startsWith('file:') === true
}

export function createMemoryStore(getBridge: () => MemoryStoreBridge) {
  let loadGeneration = 0

  return create<MemoryState>((set, get) => ({
    memories: [],
    loading: false,
    saving: false,

    async synchronize(workspaceId) {
      const generation = ++loadGeneration
      set({ workspaceId, loading: true, error: undefined })
      try {
        const listed = await getBridge().memory.list({ workspaceId })
        if (generation !== loadGeneration) return
        if (!listed.ok) {
          set({ loading: false, error: listed.error })
          return
        }
        set({ memories: listed.data, loading: false })
      } catch {
        if (generation === loadGeneration) set({ loading: false, error: transportError })
      }
    },

    async create(request) {
      return runMutation(set, get, () => getBridge().memory.create(request))
    },

    async update(request) {
      return runMutation(set, get, () => getBridge().memory.update(request))
    },

    async remove(id) {
      return runMutation(set, get, () => getBridge().memory.delete({ id }))
    },

    clearError() {
      set({ error: undefined })
    },
  }))
}

type Set = (partial: Partial<MemoryState>) => void
type Get = () => MemoryState

async function runMutation(
  set: Set,
  get: Get,
  mutate: () => Promise<IpcResult<unknown>>,
): Promise<boolean> {
  set({ saving: true, error: undefined })
  try {
    const result = await mutate()
    if (!result.ok) {
      set({ saving: false, error: result.error })
      return false
    }
    const { workspaceId } = get()
    if (workspaceId !== undefined) await get().synchronize(workspaceId)
    set({ saving: false })
    return true
  } catch {
    set({ saving: false, error: transportError })
    return false
  }
}

export const useMemoryStore = createMemoryStore(() => window.teskra)
