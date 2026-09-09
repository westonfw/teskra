import {
  WORKBENCH_EVENT_NAMES,
  type WorkbenchEventEnvelope,
  type WorkbenchEventName,
  type WorkbenchEvents,
} from '@teskra/contracts'

type AnyHandler = (payload: WorkbenchEvents[WorkbenchEventName]) => void

export type AttachRendererEventListener = (
  listener: (envelope: WorkbenchEventEnvelope) => void,
) => () => void

export interface RendererEventSubscriptions {
  subscribe<Name extends WorkbenchEventName>(
    name: Name,
    handler: (payload: WorkbenchEvents[Name]) => void,
  ): () => void
}

/** One native ipcRenderer listener fan-outs to typed Renderer subscribers. */
export function createRendererEventSubscriptions(
  attach: AttachRendererEventListener,
): RendererEventSubscriptions {
  const validNames = new Set<WorkbenchEventName>(WORKBENCH_EVENT_NAMES)
  const handlers = new Map<WorkbenchEventName, Set<AnyHandler>>()
  let detach: (() => void) | undefined

  const receive = (envelope: WorkbenchEventEnvelope): void => {
    if (!validNames.has(envelope.name)) {
      return
    }
    for (const handler of [...(handlers.get(envelope.name) ?? [])]) {
      handler(envelope.payload)
    }
  }

  return {
    subscribe(name, handler) {
      let listeners = handlers.get(name)
      if (listeners === undefined) {
        listeners = new Set()
        handlers.set(name, listeners)
      }
      listeners.add(handler as AnyHandler)
      detach ??= attach(receive)

      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        listeners?.delete(handler as AnyHandler)
        if (listeners?.size === 0) handlers.delete(name)
        if (handlers.size === 0) {
          detach?.()
          detach = undefined
        }
      }
    },
  }
}
