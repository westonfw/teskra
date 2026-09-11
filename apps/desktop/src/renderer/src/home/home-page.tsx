import { ReloadOutlined, RightOutlined } from '@ant-design/icons'
import { Button, Card, Empty, List, Space, Spin, Tag, Typography } from 'antd'
import { useEffect } from 'react'

import type { AgentHealth, AgentRun, Task, WorkflowRun, Worktree } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useDashboardStore, type DashboardBlock } from '../stores/dashboard-store'
import { useNavigationStore, type WorkbenchPage } from '../stores/navigation-store'
import { useWorkspaceStore } from '../stores/workspace-store'

interface DashboardSectionProps {
  readonly title: string
  readonly count?: number
  readonly target: WorkbenchPage
  readonly block: DashboardBlock<unknown>
  readonly onRetry: () => void
  readonly children: React.ReactNode
}

function DashboardSection({ title, count, target, block, onRetry, children }: DashboardSectionProps) {
  const navigate = useNavigationStore((state) => state.navigate)
  const loading = block.status === 'idle' || block.status === 'loading'
  return (
    <Card
      size="small"
      className="dashboard-card"
      title={
        <Space>
          <Typography.Text strong>{title}</Typography.Text>
          {count !== undefined && <Tag bordered={false}>{count}</Tag>}
        </Space>
      }
      extra={
        <Space size={0}>
          <Button
            size="small"
            type="text"
            aria-label={`Refresh ${title}`}
            icon={<ReloadOutlined />}
            onClick={onRetry}
          />
          <Button
            size="small"
            type="text"
            aria-label={`Open ${title}`}
            icon={<RightOutlined />}
            onClick={() => navigate(target)}
          />
        </Space>
      }
    >
      {block.status === 'error' && block.error !== undefined ? (
        <AppErrorAlert error={block.error} />
      ) : (
        <Spin spinning={loading} size="small">
          {children}
        </Spin>
      )}
    </Card>
  )
}

function TaskList({ tasks, empty }: { readonly tasks: readonly Task[]; readonly empty: string }) {
  const navigate = useNavigationStore((state) => state.navigate)
  return (
    <List
      size="small"
      dataSource={[...tasks]}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} /> }}
      renderItem={(item) => (
        <List.Item className="dashboard-item" onClick={() => navigate('tasks')}>
          <Typography.Text ellipsis className="dashboard-item-label">
            {item.title}
          </Typography.Text>
          <Tag bordered={false}>{item.status}</Tag>
        </List.Item>
      )}
    />
  )
}

function RunList({
  runs,
  statusTag,
  empty,
}: {
  readonly runs: readonly AgentRun[]
  readonly statusTag: (run: AgentRun) => { color: string; label: string }
  readonly empty: string
}) {
  const navigate = useNavigationStore((state) => state.navigate)
  return (
    <List
      size="small"
      dataSource={[...runs]}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} /> }}
      renderItem={(item) => {
        const tag = statusTag(item)
        return (
          <List.Item className="dashboard-item" onClick={() => navigate('runs')}>
            <Typography.Text ellipsis className="dashboard-item-label">
              {item.agentType} · {item.id}
            </Typography.Text>
            <Tag bordered={false} color={tag.color}>
              {tag.label}
            </Tag>
          </List.Item>
        )
      }}
    />
  )
}

export function HomePage() {
  const workspace = useWorkspaceStore((state) => state.current)
  const navigate = useNavigationStore((state) => state.navigate)
  const activeTasks = useDashboardStore((state) => state.activeTasks)
  const waitingForYou = useDashboardStore((state) => state.waitingForYou)
  const interruptedRuns = useDashboardStore((state) => state.interruptedRuns)
  const mergeReady = useDashboardStore((state) => state.mergeReady)
  const agentAvailability = useDashboardStore((state) => state.agentAvailability)
  const recentFailures = useDashboardStore((state) => state.recentFailures)
  const load = useDashboardStore((state) => state.load)
  const reloadBlock = useDashboardStore((state) => state.reloadBlock)
  const startSynchronization = useDashboardStore((state) => state.startSynchronization)

  useEffect(() => {
    if (workspace === undefined) return
    return startSynchronization(workspace)
  }, [workspace, startSynchronization])

  if (workspace === undefined) {
    return (
      <div className="workbench-page centered-empty">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Open a workspace to see its dashboard."
        >
          <Button type="primary" onClick={() => navigate('workspace')}>
            Choose workspace
          </Button>
        </Empty>
      </div>
    )
  }

  const waitingTasks = waitingForYou.data?.tasks ?? []
  const waitingWorkflowRuns = waitingForYou.data?.workflowRuns ?? []
  const availability = agentAvailability.data ?? []

  return (
    <div className="workbench-page home-page">
      <header className="page-heading">
        <div>
          <Typography.Text className="settings-eyebrow">HOME</Typography.Text>
          <Typography.Title level={2}>Dashboard</Typography.Title>
          <Typography.Paragraph type="secondary">
            {workspace.name} at a glance — active work, anything waiting on you, and agent health.
          </Typography.Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => load(workspace)}>
          Refresh
        </Button>
      </header>

      <div className="dashboard-grid">
        <DashboardSection
          title="Active Tasks"
          count={activeTasks.data?.total}
          target="tasks"
          block={activeTasks}
          onRetry={() => reloadBlock(workspace, 'activeTasks')}
        >
          <TaskList tasks={activeTasks.data?.items ?? []} empty="No tasks running right now." />
        </DashboardSection>

        <DashboardSection
          title="Waiting For You"
          count={waitingForYou.data?.total}
          target="tasks"
          block={waitingForYou}
          onRetry={() => reloadBlock(workspace, 'waitingForYou')}
        >
          <TaskList tasks={waitingTasks} empty="" />
          <List
            size="small"
            dataSource={[...waitingWorkflowRuns]}
            locale={{
              emptyText:
                waitingTasks.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="Nothing is waiting on you."
                  />
                ) : null,
            }}
            renderItem={(item: WorkflowRun) => (
              <List.Item className="dashboard-item" onClick={() => navigate('tasks')}>
                <Typography.Text ellipsis className="dashboard-item-label">
                  Workflow {item.definition.id} · {item.id}
                </Typography.Text>
                <Tag bordered={false} color="gold">
                  {item.status}
                </Tag>
              </List.Item>
            )}
          />
        </DashboardSection>

        <DashboardSection
          title="Interrupted Runs"
          count={interruptedRuns.data?.total}
          target="runs"
          block={interruptedRuns}
          onRetry={() => reloadBlock(workspace, 'interruptedRuns')}
        >
          <RunList
            runs={interruptedRuns.data?.items ?? []}
            statusTag={() => ({ color: 'orange', label: 'interrupted' })}
            empty="No interrupted runs."
          />
        </DashboardSection>

        <DashboardSection
          title="Merge Ready"
          count={mergeReady.data?.total}
          target="git"
          block={mergeReady}
          onRetry={() => reloadBlock(workspace, 'mergeReady')}
        >
          <List
            size="small"
            dataSource={[...(mergeReady.data?.items ?? [])]}
            locale={{
              emptyText: (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No worktrees ready to merge." />
              ),
            }}
            renderItem={(item: Worktree) => (
              <List.Item className="dashboard-item" onClick={() => navigate('git')}>
                <Typography.Text ellipsis className="dashboard-item-label">
                  {item.branch}
                </Typography.Text>
                <Tag bordered={false} color="green">
                  {item.state}
                </Tag>
              </List.Item>
            )}
          />
        </DashboardSection>

        <DashboardSection
          title="Agent Availability"
          count={availability.length === 0 ? undefined : availability.length}
          target="runs"
          block={agentAvailability}
          onRetry={() => reloadBlock(workspace, 'agentAvailability')}
        >
          <List
            size="small"
            dataSource={[...availability]}
            locale={{
              emptyText: (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No agents registered." />
              ),
            }}
            renderItem={(item: AgentHealth) => (
              <List.Item className="dashboard-item" onClick={() => navigate('runs')}>
                <Typography.Text ellipsis className="dashboard-item-label">
                  {item.agentId}
                </Typography.Text>
                <Space size={4}>
                  {item.rateLimited === true && (
                    <Tag bordered={false} color="gold">
                      rate limited
                    </Tag>
                  )}
                  <Tag
                    bordered={false}
                    color={item.available ? 'green' : item.installed ? 'gold' : 'red'}
                  >
                    {item.available ? 'available' : item.installed ? 'unavailable' : 'not installed'}
                  </Tag>
                </Space>
              </List.Item>
            )}
          />
        </DashboardSection>

        <DashboardSection
          title="Recent Failures"
          count={recentFailures.data?.total}
          target="runs"
          block={recentFailures}
          onRetry={() => reloadBlock(workspace, 'recentFailures')}
        >
          <RunList
            runs={recentFailures.data?.items ?? []}
            statusTag={() => ({ color: 'red', label: 'failed' })}
            empty="No recent failures."
          />
        </DashboardSection>
      </div>
    </div>
  )
}
