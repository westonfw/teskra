import { app, ipcMain } from 'electron'
import { join } from 'node:path'

import { createRendererEventBridge, type RendererEventBridge } from './events/renderer-event-bridge'
import { registerIpcRouter } from './ipc/router'
import { getLogger } from './logger'
import { composeTeskraRuntime } from './runtime/compose'
import type { TeskraRuntime } from './runtime/facade'

let runtime: TeskraRuntime | undefined
let rendererBridge: RendererEventBridge | undefined
const ipcRouter = registerIpcRouter(ipcMain, () => runtime)

app.whenReady().then(async () => {
  // TASK-081: all non-Electron services are built at the single composition
  // root. A structured startup failure leaves the secure shell operational.
  const composed = await composeTeskraRuntime({ appVersion: app.getVersion() })
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
