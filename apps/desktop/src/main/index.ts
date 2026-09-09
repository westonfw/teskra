import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'

import { IPC_CHANNELS } from '@teskra/contracts'

import { getLogger, initializeLogging } from './logger'
import { createTeskraPaths } from './paths'

// TASK-004: file logging first, so every later startup step is captured.
const logging = initializeLogging(createTeskraPaths())
if (!logging.ok) {
  getLogger('app').error(
    { err: logging.error },
    'File logging unavailable; falling back to stdout.',
  )
}

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

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
