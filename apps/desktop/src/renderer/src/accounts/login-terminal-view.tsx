import { Alert } from 'antd'
import { useEffect, useRef, useState } from 'react'

import { useTranslation } from '../i18n'
import { terminalRenderers, type TerminalInstance } from '../terminal/renderers'
import { bindTerminalSession } from '../terminal/terminal-session-binding'
import { accountLoginTransport, type AccountLoginBridge } from './account-login-transport'

interface LoginTerminalViewProps {
  readonly profileId: string
  /** Accessible label for the surface (usually the profile display name). */
  readonly title: string
  readonly className?: string | undefined
  readonly bridge?: AccountLoginBridge | undefined
  readonly onExited?: ((exitCode: number) => void) | undefined
}

/**
 * §24.2 — interactive xterm surface for a structured account-login session.
 * The session starts on mount (duplicate starts reuse the Main-side sessionId)
 * and is ALWAYS cancelled on unmount so no orphan login PTY survives a closed
 * view. A natural exit is reported via onExited; Main then re-detects the
 * profile status on its own.
 */
export function LoginTerminalView({
  profileId,
  title,
  className,
  bridge,
  onExited,
}: LoginTerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<TerminalInstance | null>(null)
  const onExitedRef = useRef(onExited)
  const [error, setError] = useState<string>()
  const { t } = useTranslation()
  const tRef = useRef(t)
  onExitedRef.current = onExited
  tRef.current = t

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const activeBridge = bridge ?? window.teskra

    const terminal = terminalRenderers.get('xterm').mount(host, { readOnly: false })
    terminalRef.current = terminal

    let disposed = false
    let cleanupBinding: (() => void) | undefined
    let sessionId: string | undefined

    const start = async (): Promise<void> => {
      try {
        const result = await activeBridge.account.startLogin({ profileId })
        if (disposed) {
          // The view closed while startLogin was in flight — stop the session
          // immediately so it never outlives its surface.
          if (result.ok) void activeBridge.account.cancelLogin({ sessionId: result.data.sessionId })
          return
        }
        if (!result.ok) {
          setError(result.error.message)
          return
        }
        sessionId = result.data.sessionId
        cleanupBinding = bindTerminalSession(
          sessionId,
          terminal,
          accountLoginTransport(sessionId, activeBridge),
          {
            t: (key) => tRef.current(key),
            onError: setError,
          },
        )
      } catch {
        if (!disposed) setError(tRef.current('terminal.connectionLost'))
      }
    }
    void start()

    // bindTerminalSession's onClosed carries no exit code; subscribe here for
    // the code so the wizard can distinguish success from a failed login.
    const stopExit = activeBridge.events.subscribe('account.login.exited', (event) => {
      if (sessionId !== undefined && event.sessionId === sessionId) {
        onExitedRef.current?.(event.exitCode)
      }
    })

    const fitNow = (): void => {
      if (host.clientWidth > 0 && host.clientHeight > 0) terminal.fit()
    }
    const frame = window.requestAnimationFrame(fitNow)
    const observer = new ResizeObserver(fitNow)
    observer.observe(host)

    return () => {
      disposed = true
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      stopExit()
      cleanupBinding?.()
      terminalRef.current = null
      terminal.dispose()
      if (sessionId !== undefined) {
        void activeBridge.account.cancelLogin({ sessionId })
      }
    }
  }, [bridge, profileId])

  return (
    <div className={['terminal-view', className].filter(Boolean).join(' ')} aria-label={title}>
      {error !== undefined && (
        <Alert
          className="terminal-view-error"
          banner
          closable
          type="error"
          message={error}
          onClose={() => setError(undefined)}
        />
      )}
      <div ref={hostRef} className="terminal-view-surface" />
    </div>
  )
}
