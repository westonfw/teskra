import type { IpcResult } from '@teskra/contracts'

import type { TranslationKey } from '../i18n'

export interface Disposable {
  dispose(): void
}

export interface TerminalSurface {
  write(data: string): void
  onData(handler: (data: string) => void): Disposable
  onResize(handler: (size: { cols: number; rows: number }) => void): Disposable
}

export interface TerminalSessionTransport {
  write(terminalId: string, data: string): Promise<IpcResult<void>>
  resize(terminalId: string, cols: number, rows: number): Promise<IpcResult<void>>
  subscribeOutput(terminalId: string, handler: (data: string) => void): () => void
  subscribeClosed(terminalId: string, handler: () => void): () => void
}

export interface TerminalBindingOptions {
  readonly t: (key: TranslationKey) => string
  readonly onError?: (message: string) => void
  readonly onClosed?: () => void
}

/** Connects one xterm-like surface to the typed terminal IPC/event API. */
export function bindTerminalSession(
  terminalId: string,
  surface: TerminalSurface,
  transport: TerminalSessionTransport,
  options: TerminalBindingOptions,
): () => void {
  let disposed = false
  let previousSize = ''

  const report = (message: string): void => {
    if (!disposed) options.onError?.(message)
  }
  const invoke = async (operation: Promise<IpcResult<void>>): Promise<void> => {
    try {
      const result = await operation
      if (!result.ok) report(result.error.message)
    } catch {
      report(options.t('terminal.connectionLost'))
    }
  }

  const input = surface.onData((data) => {
    if (!disposed) void invoke(transport.write(terminalId, data))
  })
  const resize = surface.onResize(({ cols, rows }) => {
    if (disposed || cols <= 0 || rows <= 0) return
    const size = `${cols}x${rows}`
    if (size === previousSize) return
    previousSize = size
    void invoke(transport.resize(terminalId, cols, rows))
  })
  const stopOutput = transport.subscribeOutput(terminalId, (data) => {
    if (!disposed) surface.write(data)
  })
  const stopClosed = transport.subscribeClosed(terminalId, () => {
    if (disposed) return
    surface.write(`\r\n\x1b[90m${options.t('terminal.exitedMarker')}\x1b[0m\r\n`)
    options.onClosed?.()
  })

  return () => {
    if (disposed) return
    disposed = true
    input.dispose()
    resize.dispose()
    stopOutput()
    stopClosed()
  }
}
