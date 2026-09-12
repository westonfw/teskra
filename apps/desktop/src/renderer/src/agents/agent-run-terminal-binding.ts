import type { IpcResult } from '@teskra/contracts'

import type { TerminalSurface } from '../terminal/terminal-session-binding'

export interface AgentRunTerminalTransport {
  send(runId: string, data: string): Promise<IpcResult<void>>
  subscribeOutput(runId: string, handler: (data: string) => void): () => void
}

export interface AgentRunTerminalBindingOptions {
  readonly onError?: (message: string) => void
  /** Localized fallback shown when the IPC send rejects without a result. */
  readonly connectionLostMessage?: string
}

/** Binds an xterm-like surface to Agent IPC without owning or stopping the Agent process. */
export function bindAgentRunTerminal(
  runId: string,
  surface: TerminalSurface,
  transport: AgentRunTerminalTransport,
  options: AgentRunTerminalBindingOptions = {},
): () => void {
  let disposed = false

  const input = surface.onData((data) => {
    if (disposed) return
    void transport
      .send(runId, data)
      .then((result) => {
        if (!disposed && !result.ok) options.onError?.(result.error.message)
      })
      .catch(() => {
        if (!disposed)
          options.onError?.(
            options.connectionLostMessage ?? 'The Agent terminal connection was interrupted.',
          )
      })
  })
  const resize = surface.onResize(() => {
    // Agent PTYs currently use ProcessManager's launch dimensions. This listener
    // is retained so renderer implementations can dispose all subscriptions.
  })
  const stopOutput = transport.subscribeOutput(runId, (data) => {
    if (!disposed) surface.write(data)
  })

  return () => {
    if (disposed) return
    disposed = true
    input.dispose()
    resize.dispose()
    stopOutput()
    // Deliberately no cancel: hiding/switching a Run must not kill its process.
  }
}
