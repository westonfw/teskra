import { Empty, Select, Space, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { AgentRun } from '@teskra/contracts'

import { AgentRunTerminal } from '../agents/agent-run-terminal'
import { useTranslation } from '../i18n'
import { useAgentStore } from '../stores/agent-store'

interface TaskTerminalPanelProps {
  /** The selected Task's Runs (any mode); newest first picks the default. */
  readonly runs: readonly AgentRun[]
  /** Set by the thread's "running in the terminal" link: focuses that Run. */
  readonly focusRunId?: string | undefined
}

/**
 * TASK-140 (teskra-tasks.md; Milestone 26 §5) — the Task page Terminal tab:
 * the raw PTY surface of any of the Task's Runs, parallel to the Thread tab
 * (exec Runs keep their structured view in the thread; interactive Runs live
 * here — the thread links over via `focusRunId`).
 */
export function TaskTerminalPanel({ runs, focusRunId }: TaskTerminalPanelProps) {
  const { t } = useTranslation()
  const output = useAgentStore((state) => state.output)
  const loadRunOutput = useAgentStore((state) => state.loadRunOutput)
  const [selectedRunId, setSelectedRunId] = useState<string>()

  // The thread's terminal link focuses its Run; otherwise the newest Run is
  // the default (runs arrive createdAt DESC from the agent store sync).
  useEffect(() => {
    if (focusRunId !== undefined) {
      setSelectedRunId(focusRunId)
      return
    }
    setSelectedRunId((current) =>
      current !== undefined && runs.some((run) => run.id === current) ? current : runs[0]?.id,
    )
  }, [focusRunId, runs])

  // Replay the durable log (same as the drawer): an active run whose output
  // predates this subscription would otherwise show a blank PTY.
  useEffect(() => {
    if (selectedRunId === undefined) return
    void loadRunOutput(selectedRunId)
  }, [selectedRunId, loadRunOutput])

  const selected = runs.find((run) => run.id === selectedRunId)

  if (runs.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('tasks.terminal.empty')} />
  }

  return (
    <div className="task-terminal-panel">
      <Space size={8} wrap className="task-terminal-picker">
        <Typography.Text type="secondary">{t('tasks.terminal.pickRun')}</Typography.Text>
        <Select
          className="task-terminal-run-select"
          value={selectedRunId}
          options={runs.map((run) => ({
            value: run.id,
            label: `${run.agentType} · ${run.status.replaceAll('_', ' ')} · ${new Date(run.createdAt).toLocaleString()}`,
          }))}
          onChange={setSelectedRunId}
        />
        {selected !== undefined && selected.mode !== 'exec' && (
          <Tag color="blue">{t('tasks.terminal.interactive')}</Tag>
        )}
      </Space>
      {selected !== undefined && (
        <AgentRunTerminal key={selected.id} run={selected} initialData={output[selected.id]} />
      )}
    </div>
  )
}
