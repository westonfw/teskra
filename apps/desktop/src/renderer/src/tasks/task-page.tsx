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
import { useEffect, useState } from 'react'

import { AgentPicker } from '../agents/agent-picker'
import { AgentRunTerminal } from '../agents/agent-run-terminal'
import { AppErrorAlert } from '../components/app-error-alert'
import { useAgentStore } from '../stores/agent-store'
import { useTaskStore } from '../stores/task-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { RunWorktreePanel } from './run-worktree-panel'
import { CriteriaPanel } from './criteria-panel'
import { ArtifactPanel } from './artifact-panel'

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
  const startRunSynchronization = useAgentStore((state) => state.startSynchronization)
  const startRun = useAgentStore((state) => state.startRun)
  const loadRunOutput = useAgentStore((state) => state.loadRunOutput)
  const clearAgentError = useAgentStore((state) => state.clearError)
  const [createOpen, setCreateOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [agentId, setAgentId] = useState<string>()
  const [prompt, setPrompt] = useState('')
  const [openRunId, setOpenRunId] = useState<string>()
  const selected = tasks.find(({ id }) => id === selectedId)
  const taskRuns = runs.filter(({ taskId }) => taskId === selected?.id)
  const openRun = runs.find(({ id }) => id === openRunId)

  useEffect(() => {
    if (workspace === undefined) return
    const stopTasks = startTaskSynchronization(workspace.id)
    const stopRuns = startRunSynchronization(workspace.id)
    void loadDefinitions()
    return () => {
      stopTasks()
      stopRuns()
    }
  }, [loadDefinitions, startRunSynchronization, startTaskSynchronization, workspace])

  useEffect(() => {
    setTitle(selected?.title ?? '')
    setDescription(selected?.description ?? '')
    setPrompt(selected?.description ?? selected?.title ?? '')
  }, [selected])

  useEffect(() => {
    if (agentId === undefined && definitions[0] !== undefined) setAgentId(definitions[0].id)
  }, [agentId, definitions])

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
    if (!ACTIVE_RUN_STATUSES.has(run.status)) await loadRunOutput(run.id)
    setOpenRunId(run.id)
  }

  return (
    <div className="workbench-page task-page">
      <header className="page-heading">
        <div>
          <Typography.Text className="settings-eyebrow">TASK-FIRST WORKBENCH</Typography.Text>
          <Typography.Title level={2}>Tasks</Typography.Title>
          <Typography.Paragraph type="secondary">
            Plan work, launch Agents, and keep every result attached to its intent.
          </Typography.Paragraph>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          Create Task
        </Button>
      </header>

      {taskError !== undefined && (
        <AppErrorAlert className="page-alert" error={taskError} onClose={clearTaskError} />
      )}
      {agentError !== undefined && (
        <AppErrorAlert className="page-alert" error={agentError} onClose={clearAgentError} />
      )}

      <div className="task-workbench">
        <Card className="task-list-card" title={`${workspace.name} Tasks`}>
          <Spin spinning={loading}>
            {tasks.length === 0 && !loading ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Create your first Task" />
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
                        <Tag color={taskStatusColor[task.status]}>{label(task.status)}</Tag>
                        <span>{runs.filter(({ taskId }) => taskId === task.id).length} runs</span>
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
            <Empty description="Select a Task to inspect it" />
          </Card>
        ) : (
          <div className="task-detail-stack">
            <Card
              className="task-detail-card"
              title="Task detail"
              extra={
                <Space>
                  <Popconfirm
                    title="Archive this Task?"
                    onConfirm={() => void archiveTask(selected.id, true)}
                  >
                    <Button icon={<InboxOutlined />} disabled={saving}>
                      Archive
                    </Button>
                  </Popconfirm>
                  <Popconfirm
                    title="Delete this Task? Historical Runs will be retained."
                    onConfirm={() => void deleteTask(selected.id)}
                  >
                    <Button danger icon={<DeleteOutlined />} disabled={saving} />
                  </Popconfirm>
                </Space>
              }
            >
              <div className="task-edit-form">
                <label>
                  <Typography.Text type="secondary">Title</Typography.Text>
                  <Input value={title} onChange={(event) => setTitle(event.target.value)} />
                </label>
                <label>
                  <Typography.Text type="secondary">Status</Typography.Text>
                  <Select<TaskStatus>
                    value={selected.status}
                    options={TASK_STATUSES.map((status) => ({
                      value: status,
                      label: label(status),
                    }))}
                    onChange={(status) => void updateTask({ id: selected.id, status })}
                  />
                </label>
                <label className="task-description-field">
                  <Typography.Text type="secondary">Description</Typography.Text>
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
                  Save Task
                </Button>
              </div>
            </Card>

            <CriteriaPanel taskId={selected.id} />

            <Card className="task-detail-card" title="Start an Agent Run">
              <Alert
                className="page-alert attended-warning"
                type="warning"
                showIcon
                message="直接修改主工作区，未做隔离"
              />
              <div className="task-run-launcher">
                <AgentPicker definitions={definitions} value={agentId} onChange={setAgentId} />
                <Input.TextArea
                  value={prompt}
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Instructions for this Run"
                />
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
                      executionMode: 'attended',
                      approvalMode: 'manual',
                    })
                  }}
                >
                  Start
                </Button>
              </div>
            </Card>

            <Card className="task-detail-card" title={`Runs · ${taskRuns.length}`}>
              {taskRuns.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No Runs yet" />
              ) : (
                <List
                  dataSource={taskRuns}
                  renderItem={(run) => (
                    <List.Item
                      actions={[
                        <Button key="open" type="link" onClick={() => void handleOpenRun(run)}>
                          {ACTIVE_RUN_STATUSES.has(run.status) ? 'Open active Run' : 'View result'}
                        </Button>,
                      ]}
                    >
                      <List.Item.Meta
                        title={
                          <Space>
                            <span>{run.agentType}</span>
                            <Tag>{label(run.status)}</Tag>
                          </Space>
                        }
                        description={`${run.model ?? 'Default model'} · ${new Date(run.createdAt).toLocaleString()}`}
                      />
                    </List.Item>
                  )}
                />
              )}
            </Card>

            <div className="task-secondary-grid">
              <Card className="task-detail-card" title="Changes">
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No Git snapshot yet" />
              </Card>
              <ArtifactPanel
                taskId={selected.id}
                runIds={taskRuns.map((run) => run.id)}
              />
            </div>

            <Card className="task-detail-card" title="Activity">
              <Timeline
                items={[
                  ...taskRuns.map((run) => ({
                    color: ACTIVE_RUN_STATUSES.has(run.status)
                      ? 'blue'
                      : run.status === 'completed'
                        ? 'green'
                        : 'gray',
                    children: `${run.agentType} · ${label(run.status)} · ${new Date(run.updatedAt).toLocaleString()}`,
                  })),
                  {
                    color: 'gray',
                    children: `Task created · ${new Date(selected.createdAt).toLocaleString()}`,
                  },
                ]}
              />
            </Card>
          </div>
        )}
      </div>

      <Modal
        title="Create Task"
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
            placeholder="Task title"
            autoFocus
          />
          <Input.TextArea
            value={newDescription}
            onChange={(event) => setNewDescription(event.target.value)}
            placeholder="Description and desired outcome"
            autoSize={{ minRows: 4, maxRows: 8 }}
          />
        </Space>
      </Modal>

      <Drawer
        title={openRun === undefined ? 'Run result' : `${openRun.agentType} Run`}
        width={680}
        open={openRun !== undefined}
        onClose={() => setOpenRunId(undefined)}
      >
        {openRun !== undefined && (
          <Space direction="vertical" size={16} className="run-detail">
            <Space>
              <Tag>{label(openRun.status)}</Tag>
              <Typography.Text code>{openRun.id}</Typography.Text>
            </Space>
            <RunWorktreePanel run={openRun} workspace={workspace} />
            <AgentRunTerminal key={openRun.id} run={openRun} initialData={output[openRun.id]} />
          </Space>
        )}
      </Drawer>
    </div>
  )
}

function label(value: string): string {
  return value.replaceAll('_', ' ')
}
