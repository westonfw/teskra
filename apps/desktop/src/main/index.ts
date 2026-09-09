import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'

import { IPC_CHANNELS } from '@teskra/contracts'

import { openDatabase, type TeskraDatabase } from './db'
import { migrateDatabase } from './db/migrations'
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

// TASK-005: the database opens at startup and closes on quit. An open failure
// is logged (via toPublicError inside openDatabase) and the app continues
// without persistence — the Renderer is never exposed to DB errors directly.
let database: TeskraDatabase | undefined

app.whenReady().then(() => {
  const opened = openDatabase(createTeskraPaths())
  if (opened.ok) {
    // TASK-006: bring the schema up to date before anything touches it. A
    // migration failure (including a newer-than-code schema version) leaves
    // the database closed and unused — never silently continued.
    const migrated = migrateDatabase(opened.data.connection)
    if (migrated.ok) {
      database = opened.data
    } else {
      getLogger('app').error(
        { err: migrated.error },
        'Database migration failed; continuing without persistence.',
      )
      opened.data.close()
    }
  } else {
    getLogger('app').error({ err: opened.error }, 'Database unavailable; continuing without it.')
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  database?.close()
  database = undefined
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
