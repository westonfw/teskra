import type { IpcResult, PendingDecision, ResolvedConfig } from '@teskra/contracts'

import type { Translation } from '../i18n'

/**
 * TASK-131 (teskra-tasks.md; design doc §9.3): desktop notifications for the
 * Decision Inbox. Lives in the renderer — the only layers allowed to touch
 * Electron's Notification surface are the renderer and the RendererEventBridge
 * (Runtime/main business modules never import electron). The renderer's HTML5
 * Notification API is forwarded to the main process by Electron, so no IPC
 * surface is added. Gated by `decisions.desktopNotifications` (default true,
 * Settings → General).
 */

export interface DecisionNotificationBridge {
  readonly settings: {
    resolveConfig(request?: { workspaceId?: string }): Promise<IpcResult<ResolvedConfig>>
  }
  readonly events: {
    subscribe(
      name: 'decision.opened',
      handler: (payload: { decision: PendingDecision }) => void,
    ): () => void
  }
}

export interface NotificationSink {
  notify(title: string, body: string): void
}

/**
 * One notification per decision, only for `blocking` severity, only while the
 * setting is on. A failed config read falls back to the built-in default
 * (on) — notifications are a convenience, never a correctness signal.
 */
export function shouldNotifyDecision(decision: PendingDecision, enabled: boolean): boolean {
  return enabled && decision.severity === 'blocking'
}

const browserNotificationSink: NotificationSink = {
  notify(title, body) {
    // Sandboxed renderer: HTML5 Notification, forwarded to the OS by Electron.
    new Notification(title, { body })
  },
}

export function startDecisionNotifications(
  getBridge: () => DecisionNotificationBridge,
  t: Translation['t'],
  sink: NotificationSink = browserNotificationSink,
): () => void {
  let enabled = true
  const seen = new Set<string>()
  void getBridge()
    .settings.resolveConfig()
    .then((result) => {
      if (result.ok) enabled = result.data.config.decisions.desktopNotifications
    })
    .catch(() => undefined)

  return getBridge().events.subscribe('decision.opened', ({ decision }) => {
    if (seen.has(decision.id) || !shouldNotifyDecision(decision, enabled)) return
    seen.add(decision.id)
    sink.notify(decision.title, t('inbox.notification.blockingBody'))
  })
}
