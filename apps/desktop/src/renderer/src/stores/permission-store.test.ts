import type { PermissionAuditEntry, PermissionRule, PublicAppError } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { enUS, type TranslationKey } from '../i18n/en-US'
import {
  canUseApprovalUi,
  elevatedEntries,
  isElevatedRisk,
  permissionEnforcementInfo,
  riskTagColor,
} from '../permissions/permission-view-model'
import {
  createPermissionStore,
  type PermissionStoreBridge,
} from './permission-store'

const translate = (key: TranslationKey): string => enUS[key]

const AT = '2026-09-10T00:00:00.000Z'

function makeRule(overrides: Partial<PermissionRule> & Pick<PermissionRule, 'id'>): PermissionRule {
  return {
    commandPattern: 'git push',
    action: 'audit',
    scope: 'session',
    createdAt: AT,
    ...overrides,
  }
}

function makeEntry(
  overrides: Partial<PermissionAuditEntry> & Pick<PermissionAuditEntry, 'id' | 'command' | 'riskLevel'>,
): PermissionAuditEntry {
  return { runId: 'run-1', detectedAt: AT, createdAt: AT, ...overrides }
}

function setup(
  initialRules: PermissionRule[] = [],
  initialAudit: PermissionAuditEntry[] = [],
  auditError?: PublicAppError,
) {
  const rules = [...initialRules]
  const audit = [...initialAudit]
  const handlers = new Map<string, Set<(payload: { runId: string; riskLevel: string }) => void>>()
  const bridge: PermissionStoreBridge = {
    permission: {
      listRules: vi.fn(async () => ({ ok: true as const, data: [...rules] })),
      createRule: vi.fn(async (request: Partial<PermissionRule>) => {
        const rule = makeRule({ id: `rule-${rules.length + 1}`, ...request })
        rules.push(rule)
        return { ok: true as const, data: rule }
      }),
      updateRule: vi.fn(async (request: { ruleId: string } & Partial<PermissionRule>) => {
        const index = rules.findIndex((rule) => rule.id === request.ruleId)
        if (index === -1) return { ok: true as const, data: null }
        rules[index] = { ...rules[index], ...request } as PermissionRule
        return { ok: true as const, data: rules[index] as PermissionRule }
      }),
      deleteRule: vi.fn(async ({ ruleId }: { ruleId: string }) => {
        const index = rules.findIndex((rule) => rule.id === ruleId)
        if (index !== -1) rules.splice(index, 1)
        return { ok: true as const, data: true }
      }),
      listAudit: vi.fn(async () =>
        auditError !== undefined
          ? { ok: false as const, error: auditError }
          : { ok: true as const, data: [...audit].reverse() },
      ),
      resolveDecision: vi.fn(async () => ({
        ok: true as const,
        data: { decision: 'always-allow' as const, persistedAs: 'rule' as const },
      })),
    },
    events: {
      subscribe: (name, handler) => {
        const registered = handlers.get(name) ?? new Set()
        registered.add(handler as (payload: { runId: string; riskLevel: string }) => void)
        handlers.set(name, registered)
        return () => registered.delete(handler as (payload: { runId: string; riskLevel: string }) => void)
      },
    },
  }
  const emitAudit = (runId: string) => {
    for (const handler of handlers.get('permission.audit_recorded') ?? []) {
      handler({ runId, riskLevel: 'READ_ONLY' })
    }
  }
  return { bridge, rules, audit, emitAudit, store: createPermissionStore(() => bridge) }
}

describe('permission view model (TASK-066)', () => {
  it('shows the approval UI only for native Agents', () => {
    expect(canUseApprovalUi('native')).toBe(true)
    expect(canUseApprovalUi('config')).toBe(false)
    expect(canUseApprovalUi('none')).toBe(false)
  })

  it('explains each enforcement mode without claiming interception', () => {
    expect(permissionEnforcementInfo('native', translate).description).toContain(
      'asks for approval itself',
    )
    expect(permissionEnforcementInfo('config', translate).description).toContain('audit-only')
    expect(permissionEnforcementInfo('none', translate).label).toBe('No enforcement')
    expect(permissionEnforcementInfo('none', translate).description).toContain('post-hoc audit')
  })

  it('marks DESTRUCTIVE / NETWORK_WRITE as elevated with distinct colors', () => {
    expect(isElevatedRisk('DESTRUCTIVE')).toBe(true)
    expect(isElevatedRisk('NETWORK_WRITE')).toBe(true)
    expect(isElevatedRisk('READ_ONLY')).toBe(false)
    expect(riskTagColor('DESTRUCTIVE')).toBe('red')
    expect(riskTagColor('NETWORK_WRITE')).toBe('orange')
    expect(riskTagColor('UNKNOWN')).toBe('default')
  })

  it('collects elevated entries chronologically', () => {
    const entries = [
      makeEntry({ id: 1, command: 'ls', riskLevel: 'READ_ONLY' }),
      makeEntry({ id: 2, command: 'git push', riskLevel: 'NETWORK_WRITE' }),
      makeEntry({ id: 3, command: 'rm -rf build', riskLevel: 'DESTRUCTIVE' }),
    ]
    expect(elevatedEntries(entries).map((entry) => entry.id)).toEqual([2, 3])
  })
})

describe('PermissionStore (TASK-066)', () => {
  it('loads rules and supports create / update / delete', async () => {
    const { store, rules } = setup([makeRule({ id: 'r-1' })])
    await store.getState().loadRules()
    expect(store.getState().rules.map((rule) => rule.id)).toEqual(['r-1'])

    expect(await store.getState().createRule({
      commandPattern: 'rm *',
      action: 'deny',
      scope: 'persistent',
    })).toBe(true)
    expect(store.getState().rules.map((rule) => rule.id)).toEqual(['r-1', 'rule-2'])

    expect(await store.getState().updateRule({ ruleId: 'rule-2', action: 'audit' })).toBe(true)
    expect(store.getState().rules.find((rule) => rule.id === 'rule-2')?.action).toBe('audit')

    await store.getState().deleteRule('rule-2')
    expect(rules.map((rule) => rule.id)).toEqual(['r-1'])
  })

  it('loads audit chronologically and refreshes on permission.audit_recorded for the run', async () => {
    const { bridge, audit, emitAudit, store } = setup([], [
      makeEntry({ id: 1, command: 'ls', riskLevel: 'READ_ONLY' }),
    ])
    const stop = store.getState().startAuditSynchronization('run-1')
    await vi.waitFor(() =>
      expect(store.getState().audit.map((entry) => entry.id)).toEqual([1]),
    )
    expect(bridge.permission.listAudit).toHaveBeenCalledWith({ runId: 'run-1' })

    emitAudit('run-2')
    await vi.waitFor(() => expect(bridge.permission.listAudit).toHaveBeenCalledTimes(1))
    audit.push(makeEntry({ id: 2, command: 'rm -rf build', riskLevel: 'DESTRUCTIVE' }))
    emitAudit('run-1')
    await vi.waitFor(() =>
      expect(store.getState().audit.map((entry) => entry.id)).toEqual([1, 2]),
    )
    stop()
  })

  it('surfaces service errors', async () => {
    const failure: PublicAppError = { code: 'UNKNOWN', message: 'boom', retryable: true }
    const { store } = setup([], [], failure)
    await store.getState().loadAudit({ runId: 'run-1' })
    expect(store.getState().error?.message).toBe('boom')
    store.getState().clearError()
    expect(store.getState().error).toBeUndefined()
  })

  it('resolves decisions and reloads rules when a persistent rule was written', async () => {
    const { bridge, store } = setup()
    await store.getState().loadRules()
    const result = await store.getState().resolveDecision({
      agentType: 'claude',
      commandPattern: 'Bash(ls)',
      decision: 'always-allow',
      runId: 'run-1',
    })
    expect(result?.persistedAs).toBe('rule')
    expect(bridge.permission.resolveDecision).toHaveBeenCalledTimes(1)
    expect(bridge.permission.listRules).toHaveBeenCalledTimes(2)
  })
})
