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
import {
  DEFAULT_CONFIG,
  type AgentRun,
  type AgentRunStatus,
  type ApprovalMode,
  type PermissionEnforcement,
} from '@teskra/contracts'
import { inspectRunWatchdog, type WatchdogInspection } from '@teskra/shared'
import { useEffect, useMemo, useState } from 'react'

import { AppErrorAlert } from '../components/app-error-alert'
import { AccountSelect } from '../accounts/account-select'
import { useAccountProfileStore } from '../accounts/account-profile-store'
import { useTranslation, type TranslationKey, type TranslationParams } from '../i18n'
import { useSettingsStore } from '../settings/settings-store'
import { agentRuntimeKey, useAgentStore } from '../stores/agent-store'
import { useNavigationStore } from '../stores/navigation-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { RunWorktreePanel } from '../tasks/run-worktree-panel'
import { AgentPicker } from './agent-picker'
import { AgentRunTerminal } from './agent-run-terminal'
import { restartAgentRunRequest, shortDuration } from './agent-watchdog'
import { RateLimitAlert } from './rate-limit-alert'

type Translate = (key: TranslationKey, params?: TranslationParams) => string

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
  const resumeRun = useAgentStore((state) => state.resumeRun)
  const cancelRun = useAgentStore((state) => state.cancelRun)
  const loadRunOutput = useAgentStore((state) => state.loadRunOutput)
  const clearError = useAgentStore((state) => state.clearError)
  const refreshAccounts = useAccountProfileStore((state) => state.refresh)
  const startAccountSynchronization = useAccountProfileStore((state) => state.startSynchronization)
  const settingsWorkspaceId = useSettingsStore((state) => state.workspaceId)
  const resolvedConfig = useSettingsStore((state) => state.resolved)
  const setSettingsWorkspace = useSettingsStore((state) => state.setWorkspace)
  const { t } = useTranslation()
  const [selectedId, setSelectedId] = useState<string>()
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [accountId, setAccountId] = useState<string>()
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('manual')
  const workspace = useWorkspaceStore((state) => state.current)
  const now = useNow(runs.some(({ status }) => ACTIVE_STATUSES.has(status)))
  const selectedRun = runs.find(({ id }) => id === selectedRunId)
  const stalledThresholdMs =
    workspace !== undefined && settingsWorkspaceId === workspace.id
      ? (resolvedConfig?.config.watchdog.stalledThresholdMs ??
        DEFAULT_CONFIG.watchdog.stalledThresholdMs)
      : DEFAULT_CONFIG.watchdog.stalledThresholdMs

  useEffect(() => {
    void loadDefinitions()
  }, [loadDefinitions])

  // §25: the launch form's Account dropdown reads the shared account store.
  useEffect(() => {
    void refreshAccounts()
    return startAccountSynchronization()
  }, [refreshAccounts, startAccountSynchronization])

  // Changing the Agent resets the account choice to "auto" (per-agent
  // default → legacy CLI home, §52).
  useEffect(() => {
    setAccountId(undefined)
  }, [selectedId])

  useEffect(() => {
    if (workspace === undefined) return
    void loadHealth(workspace.runtime)
    return startSynchronization(workspace.id)
  }, [loadHealth, startSynchronization, workspace])

  useEffect(() => {
    void setSettingsWorkspace(workspace?.id)
  }, [setSettingsWorkspace, workspace?.id])

  useEffect(() => {
    if (selectedId === undefined && definitions[0] !== undefined) {
      setSelectedId(definitions[0].id)
    }
  }, [definitions, selectedId])

  // Honor cross-page intents (e.g. Home → Merge Ready opens the owning Run's
  // drawer here, where the worktree merge action lives).
  const pendingRunId = useNavigationStore((state) => state.pendingRunId)
  const consumePendingRunId = useNavigationStore((state) => state.consumePendingRunId)
  useEffect(() => {
    if (pendingRunId === undefined) return
    if (!runs.some((run) => run.id === pendingRunId)) return
    setSelectedRunId(pendingRunId)
    consumePendingRunId()
  }, [consumePendingRunId, pendingRunId, runs])

  const names = useMemo(
    () => Object.fromEntries(definitions.map((definition) => [definition.id, definition.name])),
    [definitions],
  )
  const runtimeHealth = useMemo(
    () =>
      workspace === undefined
        ? []
        : definitions.flatMap((definition) => {
            const status = health[agentRuntimeKey(definition.id, workspace.runtime)]
            return status === undefined ? [] : [status]
          }),
    [definitions, health, workspace],
  )
  const enforcement = useMemo(
    () =>
      Object.fromEntries(
        definitions.map((definition) => [definition.id, definition.permissionEnforcement]),
      ),
    [definitions],
  )
  const selectedDefinition = definitions.find((definition) => definition.id === selectedId)

  const handleStart = async (): Promise<void> => {
    if (workspace === undefined || selectedId === undefined) return
    const run = await startRun({
      workspaceId: workspace.id,
      agentType: selectedId,
      prompt: prompt.trim() || undefined,
      model: model.trim() || undefined,
      ...(accountId === undefined ? {} : { accountProfileId: accountId }),
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
    // Always replay the durable log: the live buffer only holds frames emitted
    // while this renderer was subscribed, so a run that is already active
    // (resumed, or started before a reload) would otherwise show a blank PTY.
    await loadRunOutput(run.id)
    setSelectedRunId(run.id)
  }

  const handleRestart = async (run: AgentRun): Promise<void> => {
    if (ACTIVE_STATUSES.has(run.status) && !(await cancelRun(run.id))) return
    const restarted = await startRun(restartAgentRunRequest(run))
    if (restarted !== undefined) setSelectedRunId(restarted.id)
  }

  const handleResume = async (run: AgentRun): Promise<void> => {
    const resumed = await resumeRun(run.id)
    if (resumed !== undefined) setSelectedRunId(resumed.id)
  }

  return (
    <div className="workbench-page agent-catalog-page">
      <header className="page-heading">
        <div>
          <Typography.Text className="settings-eyebrow">{t('runs.eyebrow')}</Typography.Text>
          <Typography.Title level={2}>{t('runs.title')}</Typography.Title>
          <Typography.Paragraph type="secondary">{t('runs.subtitle')}</Typography.Paragraph>
        </div>
        <AgentPicker
          definitions={definitions}
          health={runtimeHealth}
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
        message={t('agent.attendedWarning')}
        description={t('agent.attendedWarningDetail')}
      />

      <Card className="run-launch-card" title={t('runs.launch.title')}>
        {selectedDefinition?.permissionEnforcement === 'none' && (
          <Alert
            className="page-alert"
            type="warning"
            showIcon
            message={t('agent.noEnforcement')}
            description={t('agent.noEnforcementDetailInteractive')}
          />
        )}
        <div className="run-launch-form">
          <Input.TextArea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t('runs.launch.promptPlaceholder')}
            autoSize={{ minRows: 2, maxRows: 5 }}
          />
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={t('runs.launch.modelPlaceholder')}
          />
          <AccountSelect agentId={selectedId} value={accountId} onChange={setAccountId} />
          <Select<ApprovalMode>
            value={approvalMode}
            onChange={setApprovalMode}
            options={[
              { value: 'read-only', label: t('runs.approval.read-only') },
              { value: 'manual', label: t('runs.approval.manual') },
              { value: 'safe-auto', label: t('runs.approval.safe-auto') },
              { value: 'full-auto', label: t('runs.approval.full-auto') },
            ]}
          />
          <Button
            type="primary"
            loading={starting}
            disabled={selectedId === undefined}
            onClick={() => void handleStart()}
          >
            {t('runs.launch.start')}
          </Button>
        </div>
      </Card>

      <section className="run-section">
        <div className="section-heading">
          <div>
            <Typography.Title level={4}>{t('runs.list.title')}</Typography.Title>
            <Typography.Text type="secondary">{workspace?.name}</Typography.Text>
          </div>
          <Tag>{t('runs.list.total', { count: runs.length })}</Tag>
        </div>
        <Spin spinning={runsLoading} tip={t('runs.list.loading')}>
          {runs.length === 0 && !runsLoading ? (
            <Empty description={t('runs.list.empty')} />
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
                  watchdog={inspectRunWatchdog(run, now, stalledThresholdMs)}
                  onOpen={() => void handleOpenRun(run)}
                  onCancel={() => void cancelRun(run.id)}
                  onRestart={() => void handleRestart(run)}
                  onResume={() => void handleResume(run)}
                />
              )}
            />
          )}
        </Spin>
      </section>

      <section className="run-section">
        <Typography.Title level={4}>{t('runs.agents.title')}</Typography.Title>
        <Spin spinning={loading} tip={t('runs.agents.loading')}>
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
                        {status.available ? t('agents.available') : t('agents.unavailable')}
                      </Tag>
                    )
                  }
                  onClick={() => setSelectedId(definition.id)}
                >
                  <Typography.Text type="secondary">
                    {definition.routing?.useWhen ?? t('agents.generalFallback')}
                  </Typography.Text>
                </Card>
              )
            })}
          </div>
        </Spin>
      </section>

      <Drawer
        title={selectedRun === undefined ? t('runs.detail.title') : names[selectedRun.agentType]}
        width={520}
        open={selectedRun !== undefined}
        onClose={() => setSelectedRunId(undefined)}
      >
        {selectedRun !== undefined && (
          <RunDetail
            run={selectedRun}
            workspaceName={workspace?.name ?? selectedRun.workspaceId}
            permissionEnforcement={enforcement[selectedRun.agentType]}
            activity={activity[selectedRun.id]}
            output={output[selectedRun.id]}
            now={now}
            watchdog={inspectRunWatchdog(selectedRun, now, stalledThresholdMs)}
            onCancel={() => void cancelRun(selectedRun.id)}
            onRestart={() => void handleRestart(selectedRun)}
            onResume={() => void handleResume(selectedRun)}
            onOpenRun={(next) => void handleOpenRun(next)}
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
  readonly activity?: string | undefined
  readonly now: number
  readonly watchdog: WatchdogInspection
  readonly onOpen: () => void
  readonly onCancel: () => void
  readonly onRestart: () => void
  readonly onResume: () => void
}

function RunListItem({
  run,
  agentName,
  workspaceName,
  activity,
  now,
  watchdog,
  onOpen,
  onCancel,
  onRestart,
  onResume,
}: RunListItemProps) {
  const { t } = useTranslation()
  const active = ACTIVE_STATUSES.has(run.status)
  return (
    <List.Item
      className="run-list-item"
      actions={[
        <Button key="detail" type="link" onClick={onOpen}>
          {active ? t('runs.item.openTerminal') : t('runs.item.details')}
        </Button>,
        active ? (
          <Button key="cancel" danger type="link" onClick={onCancel}>
            {t('runs.interrupt')}
          </Button>
        ) : null,
        run.status === 'interrupted' ? (
          <Button key="resume" type="link" onClick={onResume}>
            {t('runs.resume')}
          </Button>
        ) : null,
        watchdog.possiblyStalled ? (
          <Button key="restart" type="link" onClick={onRestart}>
            {t('runs.restart')}
          </Button>
        ) : null,
      ].filter(Boolean)}
    >
      <div className="run-row">
        <div className="run-row-primary">
          <Space size={8} wrap>
            <Typography.Text strong>{agentName}</Typography.Text>
            <Tag color={statusColor[run.status] ?? 'default'}>{statusLabel(run.status)}</Tag>
            {run.executionMode === 'attended' && run.worktreeId === undefined && (
              <Tag color="orange">{t('runs.item.unisolated')}</Tag>
            )}
            {watchdog.possiblyStalled && (
              <Tag color="volcano">
                {t('runs.stalled.tag', { duration: shortDuration(watchdog.silentForMs) })}
              </Tag>
            )}
          </Space>
          <Typography.Text type="secondary" ellipsis>
            {activity ?? defaultActivity(run.status, t)}
          </Typography.Text>
        </div>
        <div className="run-row-meta">
          <span>{workspaceName}</span>
          <span>{run.model ?? t('tasks.runs.defaultModel')}</span>
          <span>{elapsed(run, now)}</span>
        </div>
      </div>
    </List.Item>
  )
}

interface RunDetailProps {
  readonly run: AgentRun
  readonly workspaceName: string
  readonly permissionEnforcement?: PermissionEnforcement | undefined
  readonly activity?: string | undefined
  readonly output?: string | undefined
  readonly now: number
  readonly watchdog: WatchdogInspection
  readonly onCancel: () => void
  readonly onRestart: () => void
  readonly onResume: () => void
  readonly onOpenRun: (run: AgentRun) => void
}

function RunDetail({
  run,
  workspaceName,
  permissionEnforcement,
  activity,
  output,
  now,
  watchdog,
  onCancel,
  onRestart,
  onResume,
  onOpenRun,
}: RunDetailProps) {
  const { t } = useTranslation()
  const workspace = useWorkspaceStore((state) => state.current)
  return (
    <div className="run-detail">
      {run.executionMode === 'attended' && run.worktreeId === undefined && (
        <Alert type="warning" showIcon message={t('agent.attendedWarning')} />
      )}
      {permissionEnforcement === 'none' && (
        <Alert
          type="warning"
          showIcon
          message={t('agent.noEnforcement')}
          description={t('agent.noEnforcementDetail')}
        />
      )}
      {run.status === 'interrupted' && (
        <Alert
          type="info"
          showIcon
          message={t('runs.interrupted.message')}
          description={t('runs.interrupted.description')}
          action={
            <Button size="small" type="primary" onClick={onResume}>
              {t('runs.resume')}
            </Button>
          }
        />
      )}
      <RateLimitAlert run={run} onOpenRun={onOpenRun} />
      {watchdog.possiblyStalled && (
        <Alert
          type="warning"
          showIcon
          message={t('runs.stalled.tag', { duration: shortDuration(watchdog.silentForMs) })}
          description={t('runs.stalled.description')}
          action={
            <Space>
              <Button size="small" danger onClick={onCancel}>
                {t('runs.interrupt')}
              </Button>
              <Button size="small" onClick={onRestart}>
                {t('runs.restart')}
              </Button>
            </Space>
          }
        />
      )}
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label={t('runs.field.status')}>
          <Tag color={statusColor[run.status] ?? 'default'}>{statusLabel(run.status)}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label={t('runs.field.workspace')}>{workspaceName}</Descriptions.Item>
        <Descriptions.Item label={t('runs.field.model')}>
          {run.model ?? t('runs.field.defaultModel')}
        </Descriptions.Item>
        <Descriptions.Item label={t('runs.field.elapsed')}>{elapsed(run, now)}</Descriptions.Item>
        <Descriptions.Item label={t('runs.field.currentActivity')}>
          {activity ?? defaultActivity(run.status, t)}
        </Descriptions.Item>
        <Descriptions.Item label={t('runs.field.runId')}>
          <Typography.Text code copyable>
            {run.id}
          </Typography.Text>
        </Descriptions.Item>
      </Descriptions>
      {run.prompt !== undefined && (
        <Card size="small" title={t('runs.detail.prompt')}>
          <Typography.Paragraph className="run-prompt">{run.prompt}</Typography.Paragraph>
        </Card>
      )}
      {workspace !== undefined && <RunWorktreePanel run={run} workspace={workspace} />}
      <AgentRunTerminal key={run.id} run={run} initialData={output} />
      {ACTIVE_STATUSES.has(run.status) && (
        <Button danger onClick={onCancel}>
          {t('runs.interruptRun')}
        </Button>
      )}
    </div>
  )
}

function statusLabel(status: AgentRunStatus): string {
  return status.replaceAll('_', ' ')
}

function defaultActivity(status: AgentRunStatus, t: Translate): string {
  if (status === 'queued') return t('runs.activity.queued')
  if (status === 'preparing' || status === 'created') return t('runs.activity.preparing')
  if (status === 'completed') return t('runs.activity.completed')
  if (status === 'failed') return t('runs.activity.failed')
  if (status === 'cancelled') return t('runs.activity.cancelled')
  if (status === 'interrupted') return t('runs.activity.interrupted')
  if (status.startsWith('waiting_'))
    return t('runs.activity.waiting', { target: status.slice(12).replaceAll('_', ' ') })
  return t('runs.activity.working')
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
