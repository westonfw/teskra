import type { WorkbenchEvents } from '@teskra/contracts'

import { getLogger } from '../logger'

export type EventHandler<Events extends object, Name extends keyof Events> = (
  payload: Events[Name],
) => void

export interface EventBus<Events extends object = WorkbenchEvents> {
  emit<Name extends keyof Events>(name: Name, payload: Events[Name]): void
  /** Returns an idempotent unsubscribe function. */
  subscribe<Name extends keyof Events>(name: Name, handler: EventHandler<Events, Name>): () => void
  clear(): void
}

/**
 * In-process typed EventBus (TASK-016).
 *
 * It has no Electron dependency; RendererEventBridge (TASK-021) will be an
 * ordinary subscriber. Emission iterates over a snapshot so listeners may
 * subscribe/unsubscribe re-entrantly without corrupting the current delivery.
 * A faulty listener is logged and isolated from the remaining listeners.
 */
export function createEventBus<Events extends object = WorkbenchEvents>(): EventBus<Events> {
  type AnyHandler = (payload: Events[keyof Events]) => void
  const handlers = new Map<keyof Events, Set<AnyHandler>>()
  const logger = getLogger('runtime')

  return {
    emit(name, payload) {
      const current = handlers.get(name)
      if (current === undefined) {
        return
      }
      for (const handler of [...current]) {
        try {
          handler(payload)
        } catch (cause) {
          logger.error({ event: String(name), cause }, 'event subscriber failed')
        }
      }
    },

    subscribe(name, handler) {
      let current = handlers.get(name)
      if (current === undefined) {
        current = new Set()
        handlers.set(name, current)
      }
      current.add(handler as AnyHandler)
      let subscribed = true
      return () => {
        if (!subscribed) {
          return
        }
        subscribed = false
        current?.delete(handler as AnyHandler)
        if (current?.size === 0) {
          handlers.delete(name)
        }
      }
    },

    clear() {
      handlers.clear()
    },
  }
}
