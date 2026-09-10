import type { IpcResult } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import type { TerminalSurface } from '../terminal/terminal-session-binding'
import { bindAgentRunTerminal, type AgentRunTerminalTransport } from './agent-run-terminal-binding'

function setup() {
  let input: ((data: string) => void) | undefined
  let output: ((data: string) => void) | undefined
  const inputDispose = vi.fn()
  const resizeDispose = vi.fn()
  const stopOutput = vi.fn()
  const surface: TerminalSurface = {
    write: vi.fn(),
    onData: vi.fn((handler) => {
      input = handler
      return { dispose: inputDispose }
    }),
    onResize: vi.fn(() => ({ dispose: resizeDispose })),
  }
  const transport: AgentRunTerminalTransport = {
    send: vi.fn(async (): Promise<IpcResult<void>> => ({ ok: true, data: undefined })),
    subscribeOutput: vi.fn((_runId, handler) => {
      output = handler
      return stopOutput
    }),
  }
  return {
    surface,
    transport,
    input: (data: string) => input?.(data),
    output: (data: string) => output?.(data),
    inputDispose,
    resizeDispose,
    stopOutput,
  }
}

describe('Agent Run terminal binding', () => {
  it.each(['codex', 'claude'])('preserves raw %s PTY output and forwards input', async () => {
    const context = setup()
    const dispose = bindAgentRunTerminal('run-1', context.surface, context.transport)
    const raw = '\u001b[32mAgent output\u001b[0m\r\n'

    context.output(raw)
    context.input('continue\r')
    await vi.waitFor(() => expect(context.transport.send).toHaveBeenCalled())

    expect(context.surface.write).toHaveBeenCalledWith(raw)
    expect(context.transport.send).toHaveBeenCalledWith('run-1', 'continue\r')
    dispose()
  })

  it('detaches only the Renderer surface when switching Runs', () => {
    const context = setup()
    const dispose = bindAgentRunTerminal('run-1', context.surface, context.transport)

    dispose()
    context.output('late output')
    context.input('late input')

    expect(context.inputDispose).toHaveBeenCalledOnce()
    expect(context.resizeDispose).toHaveBeenCalledOnce()
    expect(context.stopOutput).toHaveBeenCalledOnce()
    expect(context.surface.write).not.toHaveBeenCalled()
    expect(context.transport.send).not.toHaveBeenCalled()
  })
})
