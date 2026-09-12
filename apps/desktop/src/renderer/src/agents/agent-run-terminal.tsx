import { Alert, Tag } from 'antd'
import type { AgentRun } from '@teskra/contracts'
import { useEffect, useRef, useState } from 'react'

import { useTranslation } from '../i18n'
import { terminalRenderers, type TerminalInstance } from '../terminal/renderers'
import { bindAgentRunTerminal } from './agent-run-terminal-binding'

interface AgentRunTerminalProps {
  readonly run: AgentRun
  readonly initialData?: string | undefined
}

const readOnlyStatuses = new Set<AgentRun['status']>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

/** A Run-scoped PTY surface; it never creates, closes, or reuses normal Terminal sessions. */
export function AgentRunTerminal({ run, initialData }: AgentRunTerminalProps) {
  const { t } = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<TerminalInstance | null>(null)
  const initialDataRef = useRef(initialData)
  const [error, setError] = useState<string>()
  const readOnly = readOnlyStatuses.has(run.status)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const terminal = terminalRenderers.get().mount(host, {
      initialData: initialDataRef.current,
      readOnly,
    })
    terminalRef.current = terminal
    const unbind = bindAgentRunTerminal(
      run.id,
      terminal,
      {
        send: (runId, data) => window.teskra.agent.send({ runId, data }),
        resize: (runId, cols, rows) => window.teskra.agent.resize({ runId, cols, rows }),
        subscribeOutput: (runId, handler) =>
          window.teskra.events.subscribe('agent.output', (event) => {
            if (event.runId === runId) handler(event.data)
          }),
      },
      { onError: setError, connectionLostMessage: t('runs.terminal.connectionLost') },
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
      unbind()
      terminalRef.current = null
      terminal.dispose()
    }
  }, [run.id])

  useEffect(() => {
    terminalRef.current?.setReadOnly(readOnly)
  }, [readOnly])

  return (
    <section
      className="agent-run-terminal"
      aria-label={t('runs.terminal.ariaLabel', { agentType: run.agentType, id: run.id })}
    >
      <header className="agent-run-terminal-heading">
        <span>{t('runs.terminal.title')}</span>
        <Tag bordered={false}>{run.agentType}</Tag>
      </header>
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
      <div ref={hostRef} className="agent-run-terminal-surface" />
    </section>
  )
}
