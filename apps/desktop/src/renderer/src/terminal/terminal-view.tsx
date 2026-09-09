import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { Alert } from 'antd'
import { useEffect, useRef, useState } from 'react'

import type { TerminalSession } from '@teskra/contracts'

import { bindTerminalSession } from './terminal-session-binding'

interface TerminalViewProps {
  readonly session: TerminalSession
  readonly visible?: boolean
  readonly className?: string
  readonly onClosed?: () => void
}

/** Interactive ANSI/TTY surface for a live TerminalManager session (TASK-018). */
export function TerminalView({ session, visible = true, className, onClosed }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const onClosedRef = useRef(onClosed)
  const [error, setError] = useState<string>()
  onClosedRef.current = onClosed

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.18,
      scrollback: 10_000,
      allowProposedApi: false,
      theme: {
        background: '#090d14',
        foreground: '#d9e2ef',
        cursor: '#70ddd1',
        cursorAccent: '#090d14',
        selectionBackground: '#2d5e6d99',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    fitRef.current = fit

    const cleanupBinding = bindTerminalSession(
      session.id,
      terminal,
      {
        write: (terminalId, data) => window.teskra.terminal.write({ terminalId, data }),
        resize: (terminalId, cols, rows) =>
          window.teskra.terminal.resize({ terminalId, cols, rows }),
        subscribeOutput: (terminalId, handler) =>
          window.teskra.events.subscribe('terminal.output', (event) => {
            if (event.terminalId === terminalId) handler(event.data)
          }),
        subscribeClosed: (terminalId, handler) =>
          window.teskra.events.subscribe('terminal.closed', (event) => {
            if (event.terminalId === terminalId) handler()
          }),
      },
      {
        onError: setError,
        onClosed: () => onClosedRef.current?.(),
      },
    )

    const fitNow = (): void => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit()
    }
    const frame = window.requestAnimationFrame(fitNow)
    const observer = new ResizeObserver(fitNow)
    observer.observe(host)

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      cleanupBinding()
      fitRef.current = null
      terminal.dispose()
      // The PTY deliberately remains owned by TerminalManager. Unmounting a
      // Renderer surface must never imply terminal.close() (TASK-019).
    }
  }, [session.id])

  useEffect(() => {
    if (!visible) return
    const frame = window.requestAnimationFrame(() => fitRef.current?.fit())
    return () => window.cancelAnimationFrame(frame)
  }, [visible])

  return (
    <div
      className={['terminal-view', className].filter(Boolean).join(' ')}
      aria-label={session.title}
    >
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
