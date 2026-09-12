import { describe, expect, it, vi } from 'vitest'

import type { IpcResult } from '@teskra/contracts'

import { enUS, type TranslationKey } from '../i18n/en-US'
import {
  bindTerminalSession,
  type TerminalSessionTransport,
  type TerminalSurface,
} from './terminal-session-binding'

const t = (key: TranslationKey): string => enUS[key]

function ok(): IpcResult<void> {
  return { ok: true, data: undefined }
}

function harness() {
  let input: ((data: string) => void) | undefined
  let resize: ((size: { cols: number; rows: number }) => void) | undefined
  let output: ((data: string) => void) | undefined
  let closed: (() => void) | undefined
  const inputDisposal = vi.fn()
  const resizeDisposal = vi.fn()
  const outputDisposal = vi.fn()
  const closedDisposal = vi.fn()
  const disposals = [inputDisposal, resizeDisposal, outputDisposal, closedDisposal]
  const surface: TerminalSurface = {
    write: vi.fn(),
    onData: (handler) => {
      input = handler
      return { dispose: inputDisposal }
    },
    onResize: (handler) => {
      resize = handler
      return { dispose: resizeDisposal }
    },
  }
  const transport: TerminalSessionTransport = {
    write: vi.fn(async () => ok()),
    resize: vi.fn(async () => ok()),
    subscribeOutput: (_id, handler) => {
      output = handler
      return outputDisposal
    },
    subscribeClosed: (_id, handler) => {
      closed = handler
      return closedDisposal
    },
  }
  return {
    surface,
    transport,
    disposals,
    emitInput: (data: string) => input?.(data),
    emitResize: (cols: number, rows: number) => resize?.({ cols, rows }),
    emitOutput: (data: string) => output?.(data),
    emitClosed: () => closed?.(),
  }
}

describe('terminal session binding', () => {
  it('forwards input including Ctrl+C and renders ANSI output unchanged', () => {
    const test = harness()
    bindTerminalSession('terminal-1', test.surface, test.transport, { t })

    test.emitInput('echo ready\r')
    test.emitInput('\x03')
    test.emitOutput('\x1b[32mready\x1b[0m\r\n')

    expect(test.transport.write).toHaveBeenNthCalledWith(1, 'terminal-1', 'echo ready\r')
    expect(test.transport.write).toHaveBeenNthCalledWith(2, 'terminal-1', '\x03')
    expect(test.surface.write).toHaveBeenCalledWith('\x1b[32mready\x1b[0m\r\n')
  })

  it('forwards only valid size changes and disposes without closing the PTY', () => {
    const test = harness()
    const cleanup = bindTerminalSession('terminal-1', test.surface, test.transport, { t })

    test.emitResize(120, 36)
    test.emitResize(120, 36)
    test.emitResize(0, 0)
    expect(test.transport.resize).toHaveBeenCalledOnce()
    expect(test.transport.resize).toHaveBeenCalledWith('terminal-1', 120, 36)

    cleanup()
    cleanup()
    expect(test.disposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true)
    expect(test.transport).not.toHaveProperty('close')
  })

  it('marks a closed session and reports structured transport failures', async () => {
    const test = harness()
    const onClosed = vi.fn()
    const onError = vi.fn()
    test.transport.write = vi.fn(async (): Promise<IpcResult<void>> => {
      return {
        ok: false,
        error: { code: 'TERMINAL_NOT_FOUND', message: 'Terminal closed.', retryable: false },
      }
    })
    bindTerminalSession('terminal-1', test.surface, test.transport, { t, onClosed, onError })

    test.emitClosed()
    test.emitInput('x')
    await Promise.resolve()

    expect(onClosed).toHaveBeenCalledOnce()
    expect(test.surface.write).toHaveBeenCalledWith(expect.stringContaining('[terminal exited]'))
    expect(onError).toHaveBeenCalledWith('Terminal closed.')
  })
})
