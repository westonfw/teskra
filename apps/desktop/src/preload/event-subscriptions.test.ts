import type { WorkbenchEventEnvelope } from '@teskra/contracts'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  createRendererEventSubscriptions,
  type AttachRendererEventListener,
} from './event-subscriptions'

describe('Renderer event subscriptions', () => {
  let receive: ((envelope: WorkbenchEventEnvelope) => void) | undefined
  let detach: Mock<() => void>
  let attach: AttachRendererEventListener

  beforeEach(() => {
    receive = undefined
    detach = vi.fn<() => void>()
    attach = vi.fn((listener: (envelope: WorkbenchEventEnvelope) => void) => {
      receive = listener
      return detach
    })
  })

  it('fans out through one native IPC listener without duplicate handlers', () => {
    const subscriptions = createRendererEventSubscriptions(attach)
    const first = vi.fn()
    const second = vi.fn()

    subscriptions.subscribe('process.output', first)
    subscriptions.subscribe('process.output', first)
    subscriptions.subscribe('process.output', second)

    expect(attach).toHaveBeenCalledTimes(1)
    receive?.({
      name: 'process.output',
      payload: { processId: 'process-1', data: 'hello' },
    })
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('routes only matching event names and detaches after the final cleanup', () => {
    const subscriptions = createRendererEventSubscriptions(attach)
    const processOutput = vi.fn()
    const terminalOutput = vi.fn()
    const stopProcess = subscriptions.subscribe('process.output', processOutput)
    const stopTerminal = subscriptions.subscribe('terminal.output', terminalOutput)

    receive?.({
      name: 'terminal.output',
      payload: { terminalId: 'terminal-1', data: 'ready' },
    })
    expect(processOutput).not.toHaveBeenCalled()
    expect(terminalOutput).toHaveBeenCalledWith({ terminalId: 'terminal-1', data: 'ready' })

    stopProcess()
    stopProcess()
    expect(detach).not.toHaveBeenCalled()
    stopTerminal()
    stopTerminal()
    expect(detach).toHaveBeenCalledOnce()
  })
})
