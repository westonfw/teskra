import { DeleteOutlined, InboxOutlined, PlusOutlined } from '@ant-design/icons'
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Timeline,
  Typography,
} from 'antd'
import {
  TASK_STATUSES,
  type AgentRun,
  type AgentRunStatus,
  type TaskStatus,
} from '@teskra/contracts'
import { useEffect, useMemo, useState } from 'react'

import { AgentPicker } from '../agents/agent-picker'
import { AgentRunTerminal } from '../agents/agent-run-terminal'
import { RateLimitAlert } from '../agents/rate-limit-alert'
import { AccountSelect } from '../accounts/account-select'
import { useAccountProfileStore } from '../accounts/account-profile-store'
import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation, type TranslationKey } from '../i18n'
import { RunCommandsPanel } from '../permissions/run-commands-panel'
import { agentRuntimeKey, useAgentStore } from '../stores/agent-store'
import { useTaskStore } from '../stores/task-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { RunWorktreePanel } from './run-worktree-panel'
import { taskDraftResetKey } from './task-draft'
import { CriteriaPanel } from './criteria-panel'
import { MemoryPanel } from './memory-panel'
import { ArtifactPanel } from './artifact-panel'
import { FindingsPanel } from './findings-panel'
import { ReviewPanelsPanel } from './review-panels-panel'
import { WorkflowRunPanel } from './workflow-run-panel'

const ACTIVE_RUN_STATUSES = new Set<AgentRunStatus>([
  'created',
  'queued',
  'preparing',
  'running',
  'waiting_for_user',
  'waiting_for_permission',
  'waiting_for_agent',
  'reviewing',
])

/** TASK-120 (§5.5): a queued run shows its wait reason instead of bare "queued". */
function runStatusLabel(run: AgentRun, t: (key: TranslationKey) => string): string {
  return run.status === 'queued' && run.queuedReason !== undefined
    ? t(`runs.queuedReason.${run.queuedReason}`)
    : t(`runs.status.${run.status}`)
}

const taskStatusColor: Partial<Record<TaskStatus, string>> = {
  ready: 'blue',
  running: 'cyan',
  needs_review: 'gold',
  blocked: 'orange',
  completed: 'green',
  failed: 'red',
  cancelled: 'default',
}

export function TaskPage() {
  const workspace = useWorkspaceStore((state) => state.current)
  const tasks = useTaskStore((state) => state.tasks)
  const selectedId = useTaskStore((state) => state.selectedId)
  const loading = useTaskStore((state) => state.loading)
  const saving = useTaskStore((state) => state.saving)
  const taskError = useTaskStore((state) => state.error)
  const startTaskSynchronization = useTaskStore((state) => state.startSynchronization)
  const createTask = useTaskStore((state) => state.createTask)
  const updateTask = useTaskStore((state) => state.updateTask)
  const archiveTask = useTaskStore((state) => state.archiveTask)
  const deleteTask = useTaskStore((state) => state.deleteTask)
  const selectTask = useTaskStore((state) => state.selectTask)
  const clearTaskError = useTaskStore((state) => state.clearError)
  const definitions = useAgentStore((state) => state.definitions)
  const runs = useAgentStore((state) => state.runs)
  const output = useAgentStore((state) => state.output)
  const agentError = useAgentStore((state) => state.error)
  const starting = useAgentStore((state) => state.starting)
  const loadDefinitions = useAgentStore((state) => state.loadDefinitions)
  const loadHealth = useAgentStore((state) => state.loadHealth)
  const health = useAgentStore((state) => state.health)
  const startRunSynchronization = useAgentStore((state) => state.startSynchronization)
  const startRun = useAgentStore((state) => state.startRun)
  const resumeRun = useAgentStore((state) => state.resumeRun)
  const loadRunOutput = useAgentStore((state) => state.loadRunOutput)
  const clearAgentError = useAgentStore((state) => state.clearError)
  const refreshAccounts = useAccountProfileStore((state) => state.refresh)
  const startAccountSynchronization = useAccountProfileStore((state) => state.startSynchronization)
  const [createOpen, setCreateOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [agentId, setAgentId] = useState<string>()
  const [accountId, setAccountId] = useState<string>()
  const [prompt, setPrompt] = useState('')
  const [openRunId, setOpenRunId] = useState<string>()
  const { t } = useTranslation()
  const selected = tasks.find(({ id }) => id === selectedId)
  const taskRuns = runs.filter(({ taskId }) => taskId === selected?.id)
  const openRun = runs.find(({ id }) => id === openRunId)

  useEffect(() => {
    if (workspace === undefined) return
    const stopTasks = startTaskSynchronization(workspace.id)
    const stopRuns = startRunSynchronization(workspace.id)
    void loadDefinitions()
    void loadHealth(workspace.runtime)
    return () => {
      stopTasks()
      stopRuns()
    }
  }, [loadDefinitions, loadHealth, startRunSynchronization, startTaskSynchronization, workspace])

  // §25: the run launcher's Account dropdown reads the shared account store.
  useEffect(() => {
    void refreshAccounts()
    return startAccountSynchronization()
  }, [refreshAccounts, startAccountSynchronization])

  // Changing the Agent resets the account choice to "auto" (§52 resolution).
  useEffect(() => {
    setAccountId(undefined)
  }, [agentId])

  // Re-initialize the draft fields only when the Task they were derived from
  // actually changes — a refresh that only touches status/updatedAt must not
  // wipe the edits in progress (taskDraftResetKey).
  const draftResetKey = taskDraftResetKey(selected)
  useEffect(() => {
    setTitle(selected?.title ?? '')
    setDescription(selected?.description ?? '')
    setPrompt(selected?.description ?? selected?.title ?? '')
  }, [draftResetKey])

  useEffect(() => {
    if (agentId === undefined && definitions[0] !== undefined) setAgentId(definitions[0].id)
  }, [agentId, definitions])

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

  if (workspace === undefined) return null

  const handleCreate = async (): Promise<void> => {
    const created = await createTask({
      workspaceId: workspace.id,
      title: newTitle,
      description: newDescription.trim() || undefined,
    })
    if (created !== undefined) {
      setNewTitle('')
      setNewDescription('')
      setCreateOpen(false)
    }
  }

  const handleOpenRun = async (run: AgentRun): Promise<void> => {
    // Always replay the durable log (see agent-catalog-page): an active run
    // whose output predates this renderer's subscription is otherwise blank.
    await loadRunOutput(run.id)
    setOpenRunId(run.id)
  }

  const handleResumeRun = async (run: AgentRun): Promise<void> => {
    const resumed = await resumeRun(run.id)
    if (resumed !== undefined) setOpenRunId(resumed.id)
  }

  return (
    <div className="workbench-page task-page">
      <header className="page-heading">
        <div>
          <Typography.Text className="settings-eyebrow">{t('tasks.eyebrow')}</Typography.Text>
          <Typography.Title level={2}>{t('tasks.title')}</Typography.Title>
          <Typography.Paragraph type="secondary">{t('tasks.subtitle')}</Typography.Paragraph>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          {t('tasks.create')}
        </Button>
      </header>

      {taskError !== undefined && (
        <AppErrorAlert className="page-alert" error={taskError} onClose={clearTaskError} />
      )}
      {agentError !== undefined && (
        <AppErrorAlert className="page-alert" error={agentError} onClose={clearAgentError} />
      )}

      <MemoryPanel workspaceId={workspace.id} taskId={selected?.id} />

      <div className="task-workbench">
        <Card className="task-list-card" title={t('tasks.listTitle', { name: workspace.name })}>
          <Spin spinning={loading}>
            {tasks.length === 0 && !loading ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t('tasks.empty.createFirst')}
              />
            ) : (
              <List
                dataSource={[...tasks]}
                renderItem={(task) => (
                  <List.Item
                    className={
                      task.id === selectedId ? 'task-list-item task-list-active' : 'task-list-item'
                    }
                    onClick={() => selectTask(task.id)}
                  >
                    <div>
                      <Typography.Text strong>{task.title}</Typography.Text>
                      <div className="task-list-meta">
                        <Tag color={taskStatusColor[task.status] ?? 'default'}>
                          {t(`tasks.status.${task.status}`)}
                        </Tag>
                        <span>
                          {t('tasks.runsCount', {
                            count: runs.filter(({ taskId }) => taskId === task.id).length,
                          })}
                        </span>
                      </div>
                    </div>
                  </List.Item>
                )}
              />
            )}
          </Spin>
        </Card>

        {selected === undefined ? (
          <Card className="task-detail-card centered-empty">
            <Empty description={t('tasks.empty.selectTask')} />
          </Card>
        ) : (
          <div className="task-detail-stack">
            <Card
              className="task-detail-card"
              title={t('tasks.detail.title')}
              extra={
                <Space>
                  <Popconfirm
                    title={t('tasks.detail.archiveConfirm')}
                    onConfirm={() => void archiveTask(selected.id, true)}
                  >
                    <Button icon={<InboxOutlined />} disabled={saving}>
                      {t('tasks.detail.archive')}
                    </Button>
                  </Popconfirm>
                  <Popconfirm
                    title={t('tasks.detail.deleteConfirm')}
                    onConfirm={() => void deleteTask(selected.id)}
                  >
                    <Button danger icon={<DeleteOutlined />} disabled={saving} />
                  </Popconfirm>
                </Space>
              }
            >
              <div className="task-edit-form">
                <label>
                  <Typography.Text type="secondary">{t('tasks.detail.fieldTitle')}</Typography.Text>
                  <Input value={title} onChange={(event) => setTitle(event.target.value)} />
                </label>
                <label>
                  <Typography.Text type="secondary">
                    {t('tasks.detail.fieldStatus')}
                  </Typography.Text>
                  <Select<TaskStatus>
                    value={selected.status}
                    options={TASK_STATUSES.map((status) => ({
                      value: status,
                      label: t(`tasks.status.${status}`),
                    }))}
                    onChange={(status) => void updateTask({ id: selected.id, status })}
                  />
                </label>
                <label className="task-description-field">
                  <Typography.Text type="secondary">
                    {t('tasks.detail.fieldDescription')}
                  </Typography.Text>
                  <Input.TextArea
                    value={description}
                    autoSize={{ minRows: 3, maxRows: 8 }}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </label>
                <Button
                  type="primary"
                  loading={saving}
                  disabled={title.trim().length === 0}
                  onClick={() =>
                    void updateTask({
                      id: selected.id,
                      title,
                      description: description.trim() || null,
                    })
                  }
                >
                  {t('tasks.detail.save')}
                </Button>
              </div>
            </Card>

            <CriteriaPanel taskId={selected.id} />

            <WorkflowRunPanel workspaceId={workspace.id} taskId={selected.id} />

            <ReviewPanelsPanel taskId={selected.id} />

            <Card className="task-detail-card" title={t('tasks.runLauncher.title')}>
              <Alert
                className="page-alert attended-warning"
                type="warning"
                showIcon
                message={t('agent.attendedWarning')}
              />
              <div className="task-run-launcher">
                <AgentPicker
                  definitions={definitions}
                  health={runtimeHealth}
                  value={agentId}
                  onChange={setAgentId}
                />
                <Input.TextArea
                  value={prompt}
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder={t('tasks.runLauncher.promptPlaceholder')}
                />
                <AccountSelect agentId={agentId} value={accountId} onChange={setAccountId} />
                <Button
                  type="primary"
                  loading={starting}
                  disabled={agentId === undefined}
                  onClick={() => {
                    if (agentId === undefined) return
                    void startRun({
                      workspaceId: workspace.id,
                      taskId: selected.id,
                      agentType: agentId,
                      prompt: prompt.trim() || undefined,
                      ...(accountId === undefined ? {} : { accountProfileId: accountId }),
                      executionMode: 'attended',
                      approvalMode: 'manual',
                    })
                  }}
                >
                  {t('tasks.runLauncher.start')}
                </Button>
              </div>
            </Card>

            <Card
              className="task-detail-card"
              title={t('tasks.runs.title', { count: taskRuns.length })}
            >
              {taskRuns.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('tasks.runs.empty')} />
              ) : (
                <List
                  dataSource={taskRuns}
                  renderItem={(run) => (
                    <List.Item
                      actions={[
                        <Button key="open" type="link" onClick={() => void handleOpenRun(run)}>
                          {ACTIVE_RUN_STATUSES.has(run.status)
                            ? t('tasks.runs.openActive')
                            : t('tasks.runs.viewResult')}
                        </Button>,
                        // Same affordance as the Runs page: an interrupted run
                        // can be resumed from here, not just inspected.
                        ...(run.status === 'interrupted'
                          ? [
                              <Button
                                key="resume"
                                type="link"
                                onClick={() => void handleResumeRun(run)}
                              >
                                {t('runs.resume')}
                              </Button>,
                            ]
                          : []),
                      ]}
                    >
                      <List.Item.Meta
                        title={
                          <Space>
                            <span>{run.agentType}</span>
                            <Tag>{runStatusLabel(run, t)}</Tag>
                          </Space>
                        }
                        description={`${run.model ?? t('tasks.runs.defaultModel')} · ${new Date(run.createdAt).toLocaleString()}`}
                      />
                    </List.Item>
                  )}
                />
              )}
            </Card>

            <div className="task-secondary-grid">
              <Card className="task-detail-card" title={t('tasks.changes.title')}>
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={t('tasks.changes.empty')}
                />
              </Card>
              <ArtifactPanel taskId={selected.id} runIds={taskRuns.map((run) => run.id)} />
            </div>

            <Card className="task-detail-card" title={t('tasks.activity.title')}>
              <Timeline
                items={[
                  ...taskRuns.map((run) => ({
                    color: ACTIVE_RUN_STATUSES.has(run.status)
                      ? 'blue'
                      : run.status === 'completed'
                        ? 'green'
                        : 'gray',
                    children: `${run.agentType} · ${runStatusLabel(run, t)} · ${new Date(run.updatedAt).toLocaleString()}`,
                  })),
                  {
                    color: 'gray',
                    children: t('tasks.activity.taskCreated', {
                      time: new Date(selected.createdAt).toLocaleString(),
                    }),
                  },
                ]}
              />
            </Card>
          </div>
        )}
      </div>

      <Modal
        title={t('tasks.create')}
        open={createOpen}
        confirmLoading={saving}
        okButtonProps={{ disabled: newTitle.trim().length === 0 }}
        onOk={() => void handleCreate()}
        onCancel={() => setCreateOpen(false)}
      >
        <Space direction="vertical" size={14} className="task-modal-fields">
          <Input
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder={t('tasks.createModal.titlePlaceholder')}
            autoFocus
          />
          <Input.TextArea
            value={newDescription}
            onChange={(event) => setNewDescription(event.target.value)}
            placeholder={t('tasks.createModal.descriptionPlaceholder')}
            autoSize={{ minRows: 4, maxRows: 8 }}
          />
        </Space>
      </Modal>

      <Drawer
        title={
          openRun === undefined
            ? t('tasks.drawer.runResult')
            : t('tasks.drawer.agentRun', { name: openRun.agentType })
        }
        width={680}
        open={openRun !== undefined}
        onClose={() => setOpenRunId(undefined)}
      >
        {openRun !== undefined && (
          <div className="run-detail">
            <Space>
              <Tag>{runStatusLabel(openRun, t)}</Tag>
              <Typography.Text code>{openRun.id}</Typography.Text>
            </Space>
            <RateLimitAlert run={openRun} onOpenRun={(next) => void handleOpenRun(next)} />
            <Tabs
              className="run-detail-tabs"
              items={[
                {
                  key: 'output',
                  label: t('tasks.drawer.tabOutput'),
                  children: (
                    <div className="run-detail-tab">
                      <RunWorktreePanel run={openRun} workspace={workspace} />
                      <FindingsPanel runId={openRun.id} />
                      <AgentRunTerminal
                        key={openRun.id}
                        run={openRun}
                        initialData={output[openRun.id]}
                      />
                    </div>
                  ),
                },
                {
                  key: 'commands',
                  label: t('tasks.drawer.tabCommands'),
                  children: (
                    <RunCommandsPanel
                      run={openRun}
                      definition={definitions.find(({ id }) => id === openRun.agentType)}
                    />
                  ),
                },
              ]}
            />
          </div>
        )}
      </Drawer>
    </div>
  )
}
