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

    readonly webContentsListeners = new Map<string, (event: unknown) => void>()
    readonly webContents = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((name: string, listener: (event: unknown) => void) => {
        this.webContentsListeners.set(name, listener)
      }),
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

  it('denies window.open, blocks webviews, and gates navigation to the dev origin (P1-10)', () => {
    const bridge = createRendererEventBridge(undefined, {
      preloadPath: '/app/preload.js',
      rendererHtmlPath: '/app/index.html',
      rendererUrl: 'http://localhost:5173',
    })
    bridge.createWindow()
    const window = electron.MockBrowserWindow.windows[0]
    if (window === undefined) throw new Error('expected test window')

    expect(window.webContents.setWindowOpenHandler).toHaveBeenCalledOnce()
    const openHandler = window.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as (details: {
      url: string
    }) => { action: string }
    expect(openHandler({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(openHandler({ url: 'http://localhost:5173/popup' })).toEqual({ action: 'deny' })

    const attachWebview = window.webContentsListeners.get('will-attach-webview')
    expect(attachWebview).toBeDefined()
    const attachEvent = { preventDefault: vi.fn() }
    attachWebview?.(attachEvent)
    expect(attachEvent.preventDefault).toHaveBeenCalledOnce()

    const willNavigate = window.webContentsListeners.get('will-navigate')
    expect(willNavigate).toBeDefined()
    const hmrReload = { url: 'http://localhost:5173/workspace', preventDefault: vi.fn() }
    willNavigate?.(hmrReload)
    expect(hmrReload.preventDefault).not.toHaveBeenCalled()
    const external = { url: 'https://example.com/', preventDefault: vi.fn() }
    willNavigate?.(external)
    expect(external.preventDefault).toHaveBeenCalledOnce()
  })

  it('allows only file: navigation in the packaged window (P1-10)', () => {
    const bridge = createRendererEventBridge(undefined, {
      preloadPath: '/app/preload.js',
      rendererHtmlPath: '/app/index.html',
    })
    bridge.createWindow()
    const window = electron.MockBrowserWindow.windows[0]
    if (window === undefined) throw new Error('expected test window')

    const willNavigate = window.webContentsListeners.get('will-navigate')
    const inApp = { url: 'file:///app/out/renderer/index.html', preventDefault: vi.fn() }
    willNavigate?.(inApp)
    expect(inApp.preventDefault).not.toHaveBeenCalled()
    const remote = { url: 'http://localhost:5173/', preventDefault: vi.fn() }
    willNavigate?.(remote)
    expect(remote.preventDefault).toHaveBeenCalledOnce()
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
