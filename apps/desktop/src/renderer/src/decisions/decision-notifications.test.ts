import type { IpcResult, PendingDecision, ResolvedConfig } from '@teskra/contracts'
import { DEFAULT_CONFIG } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { translate, type TranslationKey } from '../i18n'
import {
  shouldNotifyDecision,
  startDecisionNotifications,
  type DecisionNotificationBridge,
  type NotificationSink,
} from './decision-notifications'

const t = (key: TranslationKey, params?: Record<string, string | number>): string =>
  translate('en-US', key, params)

function decision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: 'decision-1',
    workspaceId: 'workspace-1',
    kind: 'stalled_run',
    status: 'open',
    severity: 'blocking',
    dedupeKey: 'stalled_run:run-1',
    title: 'Run is stalled',
    detail: { kind: 'stalled_run', silentForMs: 60_000 },
    options: [{ id: 'keep_waiting', label: 'Keep waiting' }],
    createdAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

function resolvedConfig(desktopNotifications: boolean): ResolvedConfig {
  return {
    config: { ...DEFAULT_CONFIG, decisions: { ...DEFAULT_CONFIG.decisions, desktopNotifications } },
    sources: {},
    warnings: [],
  }
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function createHarness(desktopNotifications: boolean) {
  const handlers = new Set<(payload: { decision: PendingDecision }) => void>()
  const sink: NotificationSink & { calls: Array<{ title: string; body: string }> } = {
    calls: [],
    notify(title, body) {
      this.calls.push({ title, body })
    },
  }
  const bridge: DecisionNotificationBridge = {
    settings: { resolveConfig: vi.fn(async () => ok(resolvedConfig(desktopNotifications))) },
    events: {
      subscribe: vi.fn((_name: 'decision.opened', handler) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      }),
    },
  }
  const emit = (value: PendingDecision): void => {
    for (const handler of handlers) handler({ decision: value })
  }
  return { bridge, sink, emit }
}

describe('decision desktop notifications (TASK-131)', () => {
  it('gates on severity and the setting', () => {
    expect(shouldNotifyDecision(decision({ severity: 'blocking' }), true)).toBe(true)
    expect(shouldNotifyDecision(decision({ severity: 'warning' }), true)).toBe(false)
    expect(shouldNotifyDecision(decision({ severity: 'info' }), true)).toBe(false)
    expect(shouldNotifyDecision(decision({ severity: 'blocking' }), false)).toBe(false)
  })

  it('notifies once per blocking decision while the setting is on', async () => {
    const { bridge, sink, emit } = createHarness(true)
    startDecisionNotifications(() => bridge, t, sink)
    await vi.waitFor(() => expect(bridge.settings.resolveConfig).toHaveBeenCalled())

    emit(decision({ id: 'a', severity: 'blocking' }))
    emit(decision({ id: 'b', severity: 'warning' }))
    emit(decision({ id: 'a', severity: 'blocking' }))

    expect(sink.calls).toEqual([
      { title: 'Run is stalled', body: 'A blocking decision is waiting in the Inbox.' },
    ])
  })

  it('stays silent when decisions.desktopNotifications is off', async () => {
    const { bridge, sink, emit } = createHarness(false)
    startDecisionNotifications(() => bridge, t, sink)
    await vi.waitFor(() => expect(bridge.settings.resolveConfig).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))

    emit(decision({ id: 'a', severity: 'blocking' }))

    expect(sink.calls).toEqual([])
  })
})
