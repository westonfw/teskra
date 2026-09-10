import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Input,
  List,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import type { AgentRun, AgentRunStatus, ApprovalMode } from '@teskra/contracts'
import { useEffect, useMemo, useState } from 'react'

import { AppErrorAlert } from '../components/app-error-alert'
import { agentRuntimeKey, useAgentStore } from '../stores/agent-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { AgentPicker } from './agent-picker'
import { AgentRunTerminal } from './agent-run-terminal'

const ACTIVE_STATUSES = new Set<AgentRunStatus>([
  'created',
  'queued',
  'preparing',
  'running',
  'waiting_for_user',
  'waiting_for_permission',
  'waiting_for_agent',
  'reviewing',
])

const statusColor: Partial<Record<AgentRunStatus, string>> = {
  queued: 'gold',
  preparing: 'blue',
  running: 'cyan',
  waiting_for_user: 'orange',
  waiting_for_permission: 'orange',
  waiting_for_agent: 'purple',
  reviewing: 'geekblue',
  completed: 'green',
  failed: 'red',
  cancelled: 'default',
  interrupted: 'volcano',
}

export function AgentCatalogPage() {
  const definitions = useAgentStore((state) => state.definitions)
  const loading = useAgentStore((state) => state.loading)
  const runsLoading = useAgentStore((state) => state.runsLoading)
  const starting = useAgentStore((state) => state.starting)
  const error = useAgentStore((state) => state.error)
  const health = useAgentStore((state) => state.health)
  const runs = useAgentStore((state) => state.runs)
  const activity = useAgentStore((state) => state.activity)
  const output = useAgentStore((state) => state.output)
  const loadDefinitions = useAgentStore((state) => state.loadDefinitions)
  const loadHealth = useAgentStore((state) => state.loadHealth)
  const startSynchronization = useAgentStore((state) => state.startSynchronization)
  const startRun = useAgentStore((state) => state.startRun)
  const cancelRun = useAgentStore((state) => state.cancelRun)
  const loadRunOutput = useAgentStore((state) => state.loadRunOutput)
  const clearError = useAgentStore((state) => state.clearError)
  const [selectedId, setSelectedId] = useState<string>()
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('manual')
  const workspace = useWorkspaceStore((state) => state.current)
  const now = useNow(runs.some(({ status }) => ACTIVE_STATUSES.has(status)))
  const selectedRun = runs.find(({ id }) => id === selectedRunId)

  useEffect(() => {
    void loadDefinitions()
  }, [loadDefinitions])

  useEffect(() => {
    if (workspace === undefined) return
    void loadHealth(workspace.runtime)
    return startSynchronization(workspace.id)
  }, [loadHealth, startSynchronization, workspace])

  useEffect(() => {
    if (selectedId === undefined && definitions[0] !== undefined) {
      setSelectedId(definitions[0].id)
    }
  }, [definitions, selectedId])

  const names = useMemo(
    () => Object.fromEntries(definitions.map((definition) => [definition.id, definition.name])),
    [definitions],
  )

  const handleStart = async (): Promise<void> => {
    if (workspace === undefined || selectedId === undefined) return
    const run = await startRun({
      workspaceId: workspace.id,
      agentType: selectedId,
      prompt: prompt.trim() || undefined,
      model: model.trim() || undefined,
      approvalMode,
      executionMode: 'attended',
      mode: 'interactive',
    })
    if (run !== undefined) {
      setPrompt('')
      setSelectedRunId(run.id)
    }
  }

  const handleOpenRun = async (run: AgentRun): Promise<void> => {
    if (!ACTIVE_STATUSES.has(run.status)) await loadRunOutput(run.id)
    setSelectedRunId(run.id)
  }

  return (
    <div className="workbench-page agent-catalog-page">
      <header className="page-heading">
        <div>
          <Typography.Text className="settings-eyebrow">AGENT RUNTIME</Typography.Text>
          <Typography.Title level={2}>Agent Runs</Typography.Title>
          <Typography.Paragraph type="secondary">
            Launch coding Agents and follow every run from queue to completion.
          </Typography.Paragraph>
        </div>
        <AgentPicker
          definitions={definitions}
          value={selectedId}
          onChange={setSelectedId}
          disabled={loading}
        />
      </header>

      {error !== undefined && (
        <AppErrorAlert className="page-alert" error={error} onClose={clearError} />
      )}
      <Alert
        className="page-alert attended-warning"
        type="warning"
        showIcon
        message="直接修改主工作区，未做隔离"
        description="Attended runs use the current workspace. Review changes before committing."
      />

      <Card className="run-launch-card" title="Start an attended run">
        <div className="run-launch-form">
          <Input.TextArea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe what the Agent should do…"
            autoSize={{ minRows: 2, maxRows: 5 }}
          />
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="Model override (optional)"
          />
          <Select<ApprovalMode>
            value={approvalMode}
            onChange={setApprovalMode}
            options={[
              { value: 'read-only', label: 'Read only' },
              { value: 'manual', label: 'Manual approval' },
              { value: 'safe-auto', label: 'Safe auto' },
              { value: 'full-auto', label: 'Full auto' },
            ]}
          />
          <Button
            type="primary"
            loading={starting}
            disabled={selectedId === undefined}
            onClick={() => void handleStart()}
          >
            Start run
          </Button>
        </div>
      </Card>

      <section className="run-section">
        <div className="section-heading">
          <div>
            <Typography.Title level={4}>Runs</Typography.Title>
            <Typography.Text type="secondary">{workspace?.name}</Typography.Text>
          </div>
          <Tag>{runs.length} total</Tag>
        </div>
        <Spin spinning={runsLoading} tip="Loading runs…">
          {runs.length === 0 && !runsLoading ? (
            <Empty description="No Agent runs in this workspace yet." />
          ) : (
            <List
              className="run-list"
              dataSource={[...runs]}
              renderItem={(run) => (
                <RunListItem
                  run={run}
                  agentName={names[run.agentType] ?? run.agentType}
                  workspaceName={workspace?.name ?? run.workspaceId}
                  activity={activity[run.id]}
                  now={now}
                  onOpen={() => void handleOpenRun(run)}
                  onCancel={() => void cancelRun(run.id)}
                />
              )}
            />
          )}
        </Spin>
      </section>

      <section className="run-section">
        <Typography.Title level={4}>Available Agents</Typography.Title>
        <Spin spinning={loading} tip="Loading Agents…">
          <div className="agent-card-grid">
            {definitions.map((definition) => {
              const status =
                workspace === undefined
                  ? undefined
                  : health[agentRuntimeKey(definition.id, workspace.runtime)]
              return (
                <Card
                  key={definition.id}
                  size="small"
                  className={
                    definition.id === selectedId ? 'agent-card agent-card-selected' : 'agent-card'
                  }
                  title={definition.name}
                  extra={
                    status !== undefined && (
                      <Tag color={status.available ? 'green' : 'red'}>
                        {status.available ? 'Available' : 'Unavailable'}
                      </Tag>
                    )
                  }
                  onClick={() => setSelectedId(definition.id)}
                >
                  <Typography.Text type="secondary">
                    {definition.routing?.useWhen ?? 'General coding Agent'}
                  </Typography.Text>
                </Card>
              )
            })}
          </div>
        </Spin>
      </section>

      <Drawer
        title={selectedRun === undefined ? 'Run detail' : names[selectedRun.agentType]}
        width={520}
        open={selectedRun !== undefined}
        onClose={() => setSelectedRunId(undefined)}
      >
        {selectedRun !== undefined && (
          <RunDetail
            run={selectedRun}
            workspaceName={workspace?.name ?? selectedRun.workspaceId}
            activity={activity[selectedRun.id]}
            output={output[selectedRun.id]}
            now={now}
            onCancel={() => void cancelRun(selectedRun.id)}
          />
        )}
      </Drawer>
    </div>
  )
}

interface RunListItemProps {
  readonly run: AgentRun
  readonly agentName: string
  readonly workspaceName: string
  readonly activity?: string
  readonly now: number
  readonly onOpen: () => void
  readonly onCancel: () => void
}

function RunListItem({
  run,
  agentName,
  workspaceName,
  activity,
  now,
  onOpen,
  onCancel,
}: RunListItemProps) {
  const active = ACTIVE_STATUSES.has(run.status)
  return (
    <List.Item
      className="run-list-item"
      actions={[
        <Button key="detail" type="link" onClick={onOpen}>
          Details
        </Button>,
        active ? (
          <Button key="cancel" danger type="link" onClick={onCancel}>
            Cancel
          </Button>
        ) : null,
      ].filter(Boolean)}
    >
      <div className="run-row">
        <div className="run-row-primary">
          <Space size={8} wrap>
            <Typography.Text strong>{agentName}</Typography.Text>
            <Tag color={statusColor[run.status]}>{statusLabel(run.status)}</Tag>
            {run.executionMode === 'attended' && run.worktreeId === undefined && (
              <Tag color="orange">Unisolated</Tag>
            )}
          </Space>
          <Typography.Text type="secondary" ellipsis>
            {activity ?? defaultActivity(run.status)}
          </Typography.Text>
        </div>
        <div className="run-row-meta">
          <span>{workspaceName}</span>
          <span>{run.model ?? 'Default model'}</span>
          <span>{elapsed(run, now)}</span>
        </div>
      </div>
    </List.Item>
  )
}

interface RunDetailProps {
  readonly run: AgentRun
  readonly workspaceName: string
  readonly activity?: string
  readonly output?: string
  readonly now: number
  readonly onCancel: () => void
}

function RunDetail({ run, workspaceName, activity, output, now, onCancel }: RunDetailProps) {
  return (
    <Space direction="vertical" size={20} className="run-detail">
      {run.executionMode === 'attended' && run.worktreeId === undefined && (
        <Alert type="warning" showIcon message="直接修改主工作区，未做隔离" />
      )}
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label="Status">
          <Tag color={statusColor[run.status]}>{statusLabel(run.status)}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="Workspace">{workspaceName}</Descriptions.Item>
        <Descriptions.Item label="Model">{run.model ?? 'Default'}</Descriptions.Item>
        <Descriptions.Item label="Elapsed">{elapsed(run, now)}</Descriptions.Item>
        <Descriptions.Item label="Current activity">
          {activity ?? defaultActivity(run.status)}
        </Descriptions.Item>
        <Descriptions.Item label="Run ID">
          <Typography.Text code copyable>
            {run.id}
          </Typography.Text>
        </Descriptions.Item>
      </Descriptions>
      {run.prompt !== undefined && (
        <Card size="small" title="Prompt">
          <Typography.Paragraph className="run-prompt">{run.prompt}</Typography.Paragraph>
        </Card>
      )}
      <AgentRunTerminal key={run.id} run={run} initialData={output} />
      {ACTIVE_STATUSES.has(run.status) && (
        <Button danger onClick={onCancel}>
          Cancel run
        </Button>
      )}
    </Space>
  )
}

function statusLabel(status: AgentRunStatus): string {
  return status.replaceAll('_', ' ')
}

function defaultActivity(status: AgentRunStatus): string {
  if (status === 'queued') return 'Waiting for an execution slot'
  if (status === 'preparing' || status === 'created') return 'Preparing Agent process'
  if (status === 'completed') return 'Run completed'
  if (status === 'failed') return 'Run failed'
  if (status === 'cancelled') return 'Run cancelled'
  if (status.startsWith('waiting_')) return `Waiting for ${status.slice(12).replaceAll('_', ' ')}`
  return 'Agent is working'
}

function elapsed(run: AgentRun, now: number): string {
  const start = Date.parse(run.startedAt ?? run.createdAt)
  const end = run.finishedAt === undefined ? now : Date.parse(run.finishedAt)
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours > 0
    ? `${hours}h ${minutes.toString().padStart(2, '0')}m`
    : `${minutes}m ${remainder.toString().padStart(2, '0')}s`
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}
