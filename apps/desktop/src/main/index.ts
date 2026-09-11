import { app, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'

import { createRendererEventBridge, type RendererEventBridge } from './events/renderer-event-bridge'
import { registerIpcRouter } from './ipc/router'
import { getLogger } from './logger'
import { composeTeskraRuntime } from './runtime/compose'
import type { TeskraRuntime } from './runtime/facade'
import { createSafeStorageCipher } from './security/safe-storage-cipher'

let runtime: TeskraRuntime | undefined
let rendererBridge: RendererEventBridge | undefined

// A second instance would share the single-writer SQLite database and the
// ~/.teskra data root (ADR-0003) with the first, bypassing every in-process
// guard (ProcessManager registry, active adapter map, concurrency checks) and
// running startup reconciliation twice.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  const ipcRouter = registerIpcRouter(ipcMain, () => runtime)

  app.on('second-instance', () => {
    rendererBridge?.focusOrCreateWindow()
  })

  void app.whenReady().then(async () => {
    // TASK-081: all non-Electron services are built at the single composition
    // root. A structured startup failure leaves the secure shell operational.
    const composed = await composeTeskraRuntime({
      appVersion: app.getVersion(),
      includeDevelopmentAgents: !app.isPackaged,
      openPath: (path) => shell.openPath(path),
      credentialCipher: createSafeStorageCipher(),
      selectDirectory: async () => {
        const selected = await dialog.showOpenDialog({ properties: ['openDirectory'] })
        return selected.canceled ? null : (selected.filePaths[0] ?? null)
      },
    })
    if (composed.ok) {
      runtime = composed.data
    } else {
      getLogger('app').error(
        { err: composed.error },
        'Teskra Runtime unavailable; continuing with the application shell.',
      )
    }

    rendererBridge = createRendererEventBridge(runtime?.events, {
      preloadPath: join(__dirname, '../preload/index.js'),
      rendererHtmlPath: join(__dirname, '../renderer/index.html'),
      rendererUrl: process.env['ELECTRON_RENDERER_URL'],
    })
    rendererBridge.createWindow()

    app.on('activate', () => {
      if (!rendererBridge?.hasWindows()) {
        rendererBridge?.createWindow()
      }
    })
  })

  app.on('before-quit', () => {
    ipcRouter.dispose()
    rendererBridge?.dispose()
    rendererBridge = undefined
    const disposed = runtime?.dispose()
    if (disposed !== undefined && !disposed.ok) {
      getLogger('app').error({ err: disposed.error }, 'Failed to dispose Teskra Runtime cleanly.')
    }
    runtime = undefined
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
