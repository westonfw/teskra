import type {
  AccountLoginSession,
  CancelAccountLoginRequest,
  IpcResult,
  ResizeAccountLoginRequest,
  StartAccountLoginRequest,
  WorkbenchEvents,
  WriteAccountLoginRequest,
} from '@teskra/contracts'

import type { TerminalSessionTransport } from '../terminal/terminal-session-binding'

export interface AccountLoginBridge {
  readonly account: {
    startLogin(request: StartAccountLoginRequest): Promise<IpcResult<AccountLoginSession>>
    writeLogin(request: WriteAccountLoginRequest): Promise<IpcResult<void>>
    resizeLogin(request: ResizeAccountLoginRequest): Promise<IpcResult<void>>
    cancelLogin(request: CancelAccountLoginRequest): Promise<IpcResult<void>>
  }
  readonly events: {
    subscribe<Name extends 'account.login.output' | 'account.login.exited'>(
      name: Name,
      handler: (payload: WorkbenchEvents[Name]) => void,
    ): () => void
  }
}

/**
 * §24.2 — adapts the structured account-login IPC to the generic terminal
 * surface binding so the login view reuses the same xterm wiring as regular
 * terminals. Events are filtered down to this session only.
 */
export function accountLoginTransport(
  sessionId: string,
  bridge: AccountLoginBridge,
): TerminalSessionTransport {
  return {
    write: (id, data) => bridge.account.writeLogin({ sessionId: id, data }),
    resize: (id, cols, rows) => bridge.account.resizeLogin({ sessionId: id, cols, rows }),
    subscribeOutput: (id, handler) =>
      bridge.events.subscribe('account.login.output', (event) => {
        if (event.sessionId === id) handler(event.data)
      }),
    subscribeClosed: (id, handler) =>
      bridge.events.subscribe('account.login.exited', (event) => {
        if (event.sessionId === id) handler()
      }),
  }
}
