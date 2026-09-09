import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'

import { IPC_CHANNELS } from '@teskra/contracts'

import { getLogger } from './logger'
import { composeTeskraRuntime } from './runtime/compose'
import type { TeskraRuntime } from './runtime/facade'

function createWindow(): void {
  const window = new BrowserWindow({
    title: 'Teskra',
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle(IPC_CHANNELS.ping, () => 'pong')

let runtime: TeskraRuntime | undefined

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

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
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
