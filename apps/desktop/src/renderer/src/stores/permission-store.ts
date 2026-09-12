import type {
  CreatePermissionRuleRequest,
  IpcResult,
  ListPermissionAuditRequest,
  ListPermissionRulesRequest,
  PermissionAuditEntry,
  PermissionDecisionResult,
  PermissionRule,
  PublicAppError,
  ResolvePermissionDecisionRequest,
  UpdatePermissionRuleRequest,
  WorkbenchEvents,
} from '@teskra/contracts'
import { create } from 'zustand'
import { transportError } from '../i18n'

export interface PermissionStoreBridge {
  readonly permission: {
    listRules(request?: ListPermissionRulesRequest): Promise<IpcResult<PermissionRule[]>>
    createRule(request: CreatePermissionRuleRequest): Promise<IpcResult<PermissionRule>>
    updateRule(request: UpdatePermissionRuleRequest): Promise<IpcResult<PermissionRule | null>>
    deleteRule(request: { ruleId: string }): Promise<IpcResult<boolean>>
    listAudit(request?: ListPermissionAuditRequest): Promise<IpcResult<PermissionAuditEntry[]>>
    resolveDecision(
      request: ResolvePermissionDecisionRequest,
    ): Promise<IpcResult<PermissionDecisionResult>>
  }
  readonly events: {
    subscribe<Name extends 'permission.audit_recorded' | 'permission.resolved'>(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}

interface PermissionState {
  readonly rules: readonly PermissionRule[]
  readonly audit: readonly PermissionAuditEntry[]
  readonly auditFilter: ListPermissionAuditRequest
  readonly loading: boolean
  readonly error?: PublicAppError | undefined
  loadRules(workspaceId?: string): Promise<void>
  createRule(request: CreatePermissionRuleRequest): Promise<boolean>
  updateRule(request: UpdatePermissionRuleRequest): Promise<boolean>
  deleteRule(ruleId: string, workspaceId?: string): Promise<void>
  loadAudit(filter?: ListPermissionAuditRequest): Promise<void>
  /** Live audit for one Run; refreshes when new entries are recorded. */
  startAuditSynchronization(runId: string): () => void
  resolveDecision(
    request: ResolvePermissionDecisionRequest,
  ): Promise<PermissionDecisionResult | undefined>
  clearError(): void
}

export function createPermissionStore(getBridge: () => PermissionStoreBridge) {
  let auditGeneration = 0

  return create<PermissionState>((set, get) => ({
    rules: [],
    audit: [],
    auditFilter: {},
    loading: false,

    async loadRules(workspaceId) {
      set({ loading: true, error: undefined })
      try {
        const result = await getBridge().permission.listRules(
          workspaceId === undefined ? {} : { workspaceId },
        )
        if (!result.ok) {
          set({ loading: false, error: result.error })
          return
        }
        set({ rules: result.data, loading: false })
      } catch {
        set({ loading: false, error: transportError() })
      }
    },

    async createRule(request) {
      try {
        const result = await getBridge().permission.createRule(request)
        if (!result.ok) {
          set({ error: result.error })
          return false
        }
        await get().loadRules(request.workspaceId)
        return true
      } catch {
        set({ error: transportError() })
        return false
      }
    },

    async updateRule(request) {
      try {
        const result = await getBridge().permission.updateRule(request)
        if (!result.ok) {
          set({ error: result.error })
          return false
        }
        set({
          rules: get().rules.map((rule) =>
            rule.id === request.ruleId ? (result.data ?? rule) : rule,
          ),
        })
        return true
      } catch {
        set({ error: transportError() })
        return false
      }
    },

    async deleteRule(ruleId, workspaceId) {
      try {
        const result = await getBridge().permission.deleteRule({ ruleId })
        if (!result.ok) {
          set({ error: result.error })
          return
        }
        await get().loadRules(workspaceId)
      } catch {
        set({ error: transportError() })
      }
    },

    async loadAudit(filter = {}) {
      const generation = ++auditGeneration
      set({ auditFilter: filter, loading: true, error: undefined })
      try {
        const result = await getBridge().permission.listAudit(filter)
        if (generation !== auditGeneration) return
        if (!result.ok) {
          set({ loading: false, error: result.error })
          return
        }
        // Repository returns newest first; the UI lists chronologically.
        set({ audit: [...result.data].reverse(), loading: false })
      } catch {
        if (generation === auditGeneration) set({ loading: false, error: transportError() })
      }
    },

    startAuditSynchronization(runId) {
      const filter: ListPermissionAuditRequest = { runId }
      void get().loadAudit(filter)
      const stop = getBridge().events.subscribe('permission.audit_recorded', (payload) => {
        if (payload.runId === runId) void get().loadAudit(filter)
      })
      return stop
    },

    async resolveDecision(request) {
      try {
        const result = await getBridge().permission.resolveDecision(request)
        if (!result.ok) {
          set({ error: result.error })
          return undefined
        }
        if (result.data.persistedAs === 'rule') await get().loadRules(request.workspaceId)
        return result.data
      } catch {
        set({ error: transportError() })
        return undefined
      }
    },

    clearError() {
      set({ error: undefined })
    },
  }))
}

export const usePermissionStore = createPermissionStore(() => window.teskra)
