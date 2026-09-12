import { app, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'

import { createRendererEventBridge, type RendererEventBridge } from './events/renderer-event-bridge'
import { registerIpcRouter } from './ipc/router'
import { getLogger } from './logger'
import { createTeskraPaths } from './paths'
import { composeTeskraRuntime } from './runtime/compose'
import type { TeskraRuntime } from './runtime/facade'
import { createSafeStorageCipher } from './security/safe-storage-cipher'

let runtime: TeskraRuntime | undefined
let rendererBridge: RendererEventBridge | undefined

// Scope the single-instance lock (and Electron's own writable state) to the
// Teskra data root: two instances with different TESKRA_HOME values have
// separate single-writer SQLite databases, so they are safe to coexist.
app.setPath('userData', join(createTeskraPaths().home(), 'userData'))

// WSLg's GPU stack cannot launch Electron's GPU process when the main process
// runs with --inspect (which electron-vite dev always adds): the inspector
// flags leak into the GPU child process, it exits with error_code=1002, and
// Chromium aborts with "GPU process isn't usable. Goodbye." Software
// rendering is fine for a workbench UI (the E2E suite runs the same way);
// TESKRA_GPU=1 opts back into hardware acceleration.
if (process.env['WSL_DISTRO_NAME'] !== undefined && process.env['TESKRA_GPU'] !== '1') {
  app.disableHardwareAcceleration()
}

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

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) {
      return
    }
    quitting = true
    ipcRouter.dispose()
    rendererBridge?.dispose()
    rendererBridge = undefined
    const current = runtime
    runtime = undefined
    if (current === undefined) {
      return
    }
    // P0-2: dispose() is async — it stops Agent/Terminal child processes
    // before closing the database, so the quit must wait for it. Re-invoking
    // app.quit() fires before-quit again; the `quitting` flag lets it through.
    event.preventDefault()
    void current.dispose().then(
      (disposed) => {
        if (!disposed.ok) {
          getLogger('app').error(
            { err: disposed.error },
            'Failed to dispose Teskra Runtime cleanly.',
          )
        }
        app.quit()
      },
      (cause: unknown) => {
        getLogger('app').error({ err: cause }, 'Teskra Runtime disposal threw; quitting anyway.')
        app.quit()
      },
    )
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
