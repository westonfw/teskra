import { BrowserWindow } from 'electron'

import {
  RENDERER_EVENT_CHANNEL,
  WORKBENCH_EVENT_NAMES,
  type WorkbenchEventEnvelope,
  type WorkbenchEventName,
} from '@teskra/contracts'

import type { RuntimeEventSource } from '../runtime/facade'

export interface RendererWindowOptions {
  readonly preloadPath: string
  readonly rendererHtmlPath: string
  readonly rendererUrl?: string
}

export interface RendererEventBridge {
  createWindow(): void
  hasWindows(): boolean
  dispose(): void
}

/**
 * The sole Electron window/event adapter below the application entry point.
 * Runtime events are subscribed once and broadcast as typed envelopes; closed
 * windows disappear from BrowserWindow.getAllWindows() without retaining a
 * webContents listener.
 */
export function createRendererEventBridge(
  events: RuntimeEventSource | undefined,
  options: RendererWindowOptions,
): RendererEventBridge {
  const unsubscribers =
    events === undefined
      ? []
      : WORKBENCH_EVENT_NAMES.map((name) => subscribeAndForward(events, name))
  let disposed = false

  return {
    createWindow() {
      const window = new BrowserWindow({
        title: 'Teskra',
        width: 1280,
        height: 800,
        show: false,
        webPreferences: {
          preload: options.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })

      window.on('ready-to-show', () => {
        if (!window.isDestroyed()) {
          window.show()
        }
      })

      if (options.rendererUrl !== undefined) {
        void window.loadURL(options.rendererUrl)
      } else {
        void window.loadFile(options.rendererHtmlPath)
      }
    },

    hasWindows() {
      return BrowserWindow.getAllWindows().length > 0
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const unsubscribe of unsubscribers) unsubscribe()
    },
  }
}

function subscribeAndForward<Name extends WorkbenchEventName>(
  events: RuntimeEventSource,
  name: Name,
): () => void {
  return events.subscribe(name, (payload) => {
    const envelope = { name, payload } as WorkbenchEventEnvelope<Name>
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(RENDERER_EVENT_CHANNEL, envelope)
      }
    }
  })
}
