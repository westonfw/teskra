import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep the pino file/stdout logger quiet (getLogger reads this lazily).
process.env['TESKRA_LOG_LEVEL'] = 'fatal'

const electron = vi.hoisted(() => {
  class MockBrowserWindow {
    static windows: MockBrowserWindow[] = []

    static getAllWindows(): MockBrowserWindow[] {
      return [...MockBrowserWindow.windows]
    }

    readonly webContents = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    }
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly loadURL = vi.fn(async () => undefined)
    readonly loadFile = vi.fn(async () => undefined)
    readonly listeners = new Map<string, () => void>()
    minimized = false
    destroyed = false

    constructor(readonly options: unknown) {
      MockBrowserWindow.windows.push(this)
    }

    on(name: string, listener: () => void): void {
      this.listeners.set(name, listener)
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    isMinimized(): boolean {
      return this.minimized
    }

    readonly restore = vi.fn(function (this: MockBrowserWindow) {
      this.minimized = false
    })
  }

  const app = {
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    quit: vi.fn(),
    setPath: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    isPackaged: true,
    getVersion: () => '0.0.0-test',
  }

  return { app, MockBrowserWindow }
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.MockBrowserWindow,
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: { openPath: vi.fn(async () => '') },
}))

vi.mock('./runtime/compose', () => ({
  // A structured startup failure keeps the shell operational — and needs no
  // filesystem, database or PTY in this entry-point test.
  composeTeskraRuntime: vi.fn(async () => ({
    ok: false,
    error: { code: 'UNKNOWN', message: 'unavailable in test', retryable: false },
  })),
}))

vi.mock('./ipc/router', () => ({
  registerIpcRouter: vi.fn(() => ({ dispose: vi.fn() })),
}))

vi.mock('./security/safe-storage-cipher', () => ({
  createSafeStorageCipher: vi.fn(() => ({ encrypt: vi.fn(), decrypt: vi.fn() })),
}))

async function importEntryPoint(): Promise<void> {
  vi.resetModules()
  await import('./index')
}

async function flushStartup(): Promise<void> {
  await vi.waitFor(() => {
    expect(electron.MockBrowserWindow.windows.length).toBeGreaterThan(0)
  })
}

function appListener(name: string): (...args: never[]) => void {
  const call = electron.app.on.mock.calls.find(([event]) => event === name)
  if (call === undefined) throw new Error(`app.on('${name}') was never registered`)
  return call[1] as (...args: never[]) => void
}

beforeEach(() => {
  electron.MockBrowserWindow.windows = []
  vi.clearAllMocks()
  electron.app.whenReady.mockReturnValue(Promise.resolve())
  electron.app.requestSingleInstanceLock.mockReturnValue(true)
})

afterEach(() => {
  vi.resetModules()
})

describe('main process entry point', () => {
  it('scopes Electron userData (and with it the instance lock) to the Teskra data root before locking', async () => {
    process.env['TESKRA_HOME'] = '/tmp/teskra-entry-test-home'
    try {
      await importEntryPoint()

      expect(electron.app.setPath).toHaveBeenCalledWith(
        'userData',
        '/tmp/teskra-entry-test-home/userData',
      )
      const setPathOrder = electron.app.setPath.mock.invocationCallOrder[0]
      const lockOrder = electron.app.requestSingleInstanceLock.mock.invocationCallOrder[0]
      if (setPathOrder === undefined || lockOrder === undefined) {
        throw new Error('expected both setPath and requestSingleInstanceLock to be called')
      }
      expect(setPathOrder).toBeLessThan(lockOrder)
    } finally {
      delete process.env['TESKRA_HOME']
    }
  })

  it('quits immediately when another instance already holds the single-instance lock', async () => {
    electron.app.requestSingleInstanceLock.mockReturnValue(false)

    await importEntryPoint()

    expect(electron.app.quit).toHaveBeenCalledOnce()
    // A second instance must not boot the runtime against the same data root.
    expect(electron.app.whenReady).not.toHaveBeenCalled()
  })

  it('boots normally while holding the lock and refocuses the window on second-instance', async () => {
    await importEntryPoint()
    await flushStartup()

    expect(electron.app.quit).not.toHaveBeenCalled()
    const window = electron.MockBrowserWindow.windows[0]
    if (window === undefined) throw new Error('expected the startup window')
    window.minimized = true

    appListener('second-instance')()

    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(electron.MockBrowserWindow.windows).toHaveLength(1)
  })

  it('creates a window on second-instance when every window was closed', async () => {
    await importEntryPoint()
    await flushStartup()
    // Simulate window-all-closed on a platform where the app keeps running.
    electron.MockBrowserWindow.windows = []

    appListener('second-instance')()

    expect(electron.MockBrowserWindow.windows).toHaveLength(1)
  })
})
