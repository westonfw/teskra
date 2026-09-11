import { RENDERER_EVENT_CHANNEL } from '@teskra/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createEventBus } from './event-bus'
import { createRendererEventBridge } from './renderer-event-bridge'

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

  return { MockBrowserWindow }
})

vi.mock('electron', () => ({ BrowserWindow: electron.MockBrowserWindow }))

describe('RendererEventBridge', () => {
  beforeEach(() => {
    electron.MockBrowserWindow.windows = []
  })

  it('creates a secure window and selects the configured renderer target', () => {
    const bridge = createRendererEventBridge(undefined, {
      preloadPath: '/app/preload.js',
      rendererHtmlPath: '/app/index.html',
      rendererUrl: 'http://localhost:5173',
    })

    bridge.createWindow()
    const window = electron.MockBrowserWindow.windows[0]
    expect(window?.options).toMatchObject({
      show: false,
      webPreferences: {
        preload: '/app/preload.js',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    expect(window?.loadURL).toHaveBeenCalledWith('http://localhost:5173')
    expect(window?.loadFile).not.toHaveBeenCalled()
    window?.listeners.get('ready-to-show')?.()
    expect(window?.show).toHaveBeenCalledOnce()
    expect(bridge.hasWindows()).toBe(true)
  })

  it('subscribes once and broadcasts typed events to each live window', () => {
    const events = createEventBus()
    const bridge = createRendererEventBridge(events, {
      preloadPath: '/app/preload.js',
      rendererHtmlPath: '/app/index.html',
    })
    bridge.createWindow()
    bridge.createWindow()

    events.emit('process.output', { processId: 'process-1', data: 'hello' })
    for (const window of electron.MockBrowserWindow.windows) {
      expect(window.webContents.send).toHaveBeenCalledOnce()
      expect(window.webContents.send).toHaveBeenCalledWith(RENDERER_EVENT_CHANNEL, {
        name: 'process.output',
        payload: { processId: 'process-1', data: 'hello' },
      })
    }
  })

  it('focuses the existing window on focusOrCreateWindow and restores it when minimized', () => {
    const bridge = createRendererEventBridge(undefined, {
      preloadPath: '/app/preload.js',
      rendererHtmlPath: '/app/index.html',
    })
    bridge.createWindow()
    const window = electron.MockBrowserWindow.windows[0]
    if (window === undefined) throw new Error('expected test window')
    window.minimized = true

    bridge.focusOrCreateWindow()

    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(electron.MockBrowserWindow.windows).toHaveLength(1)
  })

  it('creates a window on focusOrCreateWindow when every window was closed', () => {
    const bridge = createRendererEventBridge(undefined, {
      preloadPath: '/app/preload.js',
      rendererHtmlPath: '/app/index.html',
    })

    bridge.focusOrCreateWindow()

    expect(electron.MockBrowserWindow.windows).toHaveLength(1)
  })

  it('skips closed pages and removes all EventBus listeners on dispose', () => {
    const events = createEventBus()
    const bridge = createRendererEventBridge(events, {
      preloadPath: '/app/preload.js',
      rendererHtmlPath: '/app/index.html',
    })
    bridge.createWindow()
    const window = electron.MockBrowserWindow.windows[0]
    if (window === undefined) throw new Error('expected test window')
    window.webContents.isDestroyed.mockReturnValue(true)

    events.emit('terminal.output', { terminalId: 'terminal-1', data: 'ignored' })
    expect(window.webContents.send).not.toHaveBeenCalled()

    window.webContents.isDestroyed.mockReturnValue(false)
    bridge.dispose()
    bridge.dispose()
    events.emit('terminal.output', { terminalId: 'terminal-1', data: 'also ignored' })
    expect(window.webContents.send).not.toHaveBeenCalled()
  })
})
