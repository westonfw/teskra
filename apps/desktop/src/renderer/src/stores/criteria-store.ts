import type {
  AcceptanceCriteriaSet,
  AcceptanceCriteriaSetDetail,
  AcceptanceCriterion,
  AddCriterionRequest,
  IpcResult,
  PublicAppError,
  UpdateCriterionRequest,
  WorkbenchEvents,
} from '@teskra/contracts'
import { create } from 'zustand'
import { transportError } from '../i18n'

export interface CriteriaStoreBridge {
  readonly criteria: {
    listSets(request: { taskId: string }): Promise<IpcResult<AcceptanceCriteriaSet[]>>
    getSet(request: { setId: string }): Promise<IpcResult<AcceptanceCriteriaSetDetail | null>>
    createSet(request: { taskId: string }): Promise<IpcResult<AcceptanceCriteriaSetDetail>>
    addCriterion(request: AddCriterionRequest): Promise<IpcResult<AcceptanceCriterion>>
    updateCriterion(request: UpdateCriterionRequest): Promise<IpcResult<AcceptanceCriterion>>
    removeCriterion(request: { criterionId: string }): Promise<IpcResult<boolean>>
    confirmSet(request: { setId: string }): Promise<IpcResult<AcceptanceCriteriaSet>>
  }
  readonly events: {
    subscribe<Name extends 'task.updated'>(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}

interface CriteriaState {
  readonly taskId?: string
  readonly details: readonly AcceptanceCriteriaSetDetail[]
  readonly loading: boolean
  readonly saving: boolean
  readonly error?: PublicAppError
  startSynchronization(taskId: string): () => void
  synchronize(taskId: string): Promise<void>
  /** Creates the next draft version, copying the source set's criteria when given. */
  createDraftSet(taskId: string, sourceSetId?: string): Promise<boolean>
  addCriterion(request: AddCriterionRequest): Promise<boolean>
  updateCriterion(request: UpdateCriterionRequest): Promise<boolean>
  removeCriterion(criterionId: string): Promise<boolean>
  confirmSet(setId: string): Promise<boolean>
  clearError(): void
}

/** Newest version first. */
export function sortCriteriaDetails(
  details: readonly AcceptanceCriteriaSetDetail[],
): AcceptanceCriteriaSetDetail[] {
  return [...details].sort((left, right) => right.set.version - left.set.version)
}

/** Only `draft` sets are editable; `confirmed` / `superseded` are immutable. */
export function isCriteriaSetEditable(set: AcceptanceCriteriaSet): boolean {
  return set.status === 'draft'
}

export function editableCriteriaDetail(
  details: readonly AcceptanceCriteriaSetDetail[],
): AcceptanceCriteriaSetDetail | undefined {
  return sortCriteriaDetails(details).find(({ set }) => isCriteriaSetEditable(set))
}

export function createCriteriaStore(getBridge: () => CriteriaStoreBridge) {
  let synchronizationGeneration = 0
  let loadGeneration = 0

  return create<CriteriaState>((set, get) => ({
    details: [],
    loading: false,
    saving: false,

    startSynchronization(taskId) {
      const generation = ++synchronizationGeneration
      if (get().taskId !== taskId) set({ taskId, details: [] })
      const stop = getBridge().events.subscribe('task.updated', (payload) => {
        if (payload.taskId === taskId) void get().synchronize(taskId)
      })
      void get().synchronize(taskId)
      return () => {
        if (generation === synchronizationGeneration) synchronizationGeneration += 1
        stop()
      }
    },

    async synchronize(taskId) {
      const generation = ++loadGeneration
      set({ taskId, loading: true, error: undefined })
      try {
        const sets = await getBridge().criteria.listSets({ taskId })
        if (generation !== loadGeneration) return
        if (!sets.ok) {
          set({ loading: false, error: sets.error })
          return
        }
        const resolved = await Promise.all(
          sets.data.map((set) => getBridge().criteria.getSet({ setId: set.id })),
        )
        if (generation !== loadGeneration) return
        const failure = resolved.find((result) => !result.ok)
        if (failure !== undefined && !failure.ok) {
          set({ loading: false, error: failure.error })
          return
        }
        set({
          details: sortCriteriaDetails(
            resolved.flatMap((result) =>
              result.ok && result.data !== null ? [result.data] : [],
            ),
          ),
          loading: false,
        })
      } catch {
        if (generation === loadGeneration) set({ loading: false, error: transportError() })
      }
    },

    async createDraftSet(taskId, sourceSetId) {
      set({ saving: true, error: undefined })
      try {
        const created = await getBridge().criteria.createSet({ taskId })
        if (!created.ok) {
          set({ saving: false, error: created.error })
          return false
        }
        const source = get().details.find(({ set }) => set.id === sourceSetId)
        if (source !== undefined) {
          for (const criterion of source.criteria) {
            const copied = await getBridge().criteria.addCriterion({
              setId: created.data.set.id,
              description: criterion.description,
              ...(criterion.category === undefined ? {} : { category: criterion.category }),
              required: criterion.required,
            })
            if (!copied.ok) {
              set({ saving: false, error: copied.error })
              return false
            }
          }
        }
        await get().synchronize(taskId)
        set({ saving: false })
        return true
      } catch {
        set({ saving: false, error: transportError() })
        return false
      }
    },

    async addCriterion(request) {
      return runMutation(set, get, () => getBridge().criteria.addCriterion(request))
    },

    async updateCriterion(request) {
      return runMutation(set, get, () => getBridge().criteria.updateCriterion(request))
    },

    async removeCriterion(criterionId) {
      return runMutation(set, get, () => getBridge().criteria.removeCriterion({ criterionId }))
    },

    async confirmSet(setId) {
      return runMutation(set, get, () => getBridge().criteria.confirmSet({ setId }))
    },

    clearError() {
      set({ error: undefined })
    },
  }))
}

type Set = (partial: Partial<CriteriaState>) => void
type Get = () => CriteriaState

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
    const { taskId } = get()
    if (taskId !== undefined) await get().synchronize(taskId)
    set({ saving: false })
    return true
  } catch {
    set({ saving: false, error: transportError() })
    return false
  }
}

export const useCriteriaStore = createCriteriaStore(() => window.teskra)
