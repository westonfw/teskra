import { Alert } from 'antd'
import { useEffect, useRef, useState } from 'react'

import type { TerminalSession } from '@teskra/contracts'

import { useTranslation } from '../i18n'
import { terminalRenderers, type TerminalInstance } from './renderers'
import { bindTerminalSession } from './terminal-session-binding'

interface TerminalViewProps {
  readonly session: TerminalSession
  readonly visible?: boolean
  readonly initialData?: string
  readonly readOnly?: boolean
  readonly className?: string
  readonly onClosed?: () => void
  readonly rendererName?: string
}

/** Interactive ANSI/TTY surface for a live TerminalManager session (TASK-018). */
export function TerminalView({
  session,
  visible = true,
  initialData,
  readOnly = false,
  className,
  onClosed,
  rendererName,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<TerminalInstance | null>(null)
  const initialDataRef = useRef(initialData)
  const onClosedRef = useRef(onClosed)
  const [error, setError] = useState<string>()
  const { t } = useTranslation()
  const tRef = useRef(t)
  onClosedRef.current = onClosed
  tRef.current = t

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    const terminal = terminalRenderers.get(rendererName).mount(host, {
      initialData: initialDataRef.current,
      readOnly,
    })
    terminalRef.current = terminal

    const cleanupBinding = readOnly
      ? undefined
      : bindTerminalSession(
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
            t: (key) => tRef.current(key),
            onError: setError,
            onClosed: () => onClosedRef.current?.(),
          },
        )

    const fitNow = (): void => {
      if (host.clientWidth > 0 && host.clientHeight > 0) terminal.fit()
    }
    const frame = window.requestAnimationFrame(fitNow)
    const observer = new ResizeObserver(fitNow)
    observer.observe(host)

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      cleanupBinding?.()
      terminalRef.current = null
      terminal.dispose()
      // The PTY deliberately remains owned by TerminalManager. Unmounting a
      // Renderer surface must never imply terminal.close() (TASK-019).
    }
  }, [rendererName, session.id])

  useEffect(() => {
    terminalRef.current?.setReadOnly(readOnly)
  }, [readOnly])

  useEffect(() => {
    if (!visible) return
    const frame = window.requestAnimationFrame(() => terminalRef.current?.fit())
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
