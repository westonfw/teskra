import { ReloadOutlined, RightOutlined } from '@ant-design/icons'
import { Button, Card, Empty, List, Space, Spin, Tag, Typography } from 'antd'
import { useEffect } from 'react'

import type { AgentHealth, AgentRun, Task, WorkflowRun, Worktree } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
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

function DashboardSection({
  title,
  count,
  target,
  block,
  onRetry,
  children,
}: DashboardSectionProps) {
  const { t } = useTranslation()
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
            aria-label={t('home.section.refresh', { title })}
            icon={<ReloadOutlined />}
            onClick={onRetry}
          />
          <Button
            size="small"
            type="text"
            aria-label={t('home.section.open', { title })}
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
  const { t } = useTranslation()
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
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('home.noWorkspace.body')}>
          <Button type="primary" onClick={() => navigate('workspace')}>
            {t('workspaceRequired.action')}
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
          <Typography.Text className="settings-eyebrow">{t('home.eyebrow')}</Typography.Text>
          <Typography.Title level={2}>{t('home.title')}</Typography.Title>
          <Typography.Paragraph type="secondary">
            {t('home.subtitle', { name: workspace.name })}
          </Typography.Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => load(workspace)}>
          {t('home.refresh')}
        </Button>
      </header>

      <div className="dashboard-grid">
        <DashboardSection
          title={t('home.section.activeTasks')}
          count={activeTasks.data?.total}
          target="tasks"
          block={activeTasks}
          onRetry={() => reloadBlock(workspace, 'activeTasks')}
        >
          <TaskList tasks={activeTasks.data?.items ?? []} empty={t('home.empty.activeTasks')} />
        </DashboardSection>

        <DashboardSection
          title={t('home.section.waitingForYou')}
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
                    description={t('home.empty.waitingForYou')}
                  />
                ) : null,
            }}
            renderItem={(item: WorkflowRun) => (
              <List.Item className="dashboard-item" onClick={() => navigate('tasks')}>
                <Typography.Text ellipsis className="dashboard-item-label">
                  {t('home.workflow')} {item.definition.id} · {item.id}
                </Typography.Text>
                <Tag bordered={false} color="gold">
                  {item.status}
                </Tag>
              </List.Item>
            )}
          />
        </DashboardSection>

        <DashboardSection
          title={t('home.section.interruptedRuns')}
          count={interruptedRuns.data?.total}
          target="runs"
          block={interruptedRuns}
          onRetry={() => reloadBlock(workspace, 'interruptedRuns')}
        >
          <RunList
            runs={interruptedRuns.data?.items ?? []}
            statusTag={() => ({ color: 'orange', label: t('home.run.interrupted') })}
            empty={t('home.empty.interruptedRuns')}
          />
        </DashboardSection>

        <DashboardSection
          title={t('home.section.mergeReady')}
          count={mergeReady.data?.total}
          target="runs"
          block={mergeReady}
          onRetry={() => reloadBlock(workspace, 'mergeReady')}
        >
          <List
            size="small"
            dataSource={[...(mergeReady.data?.items ?? [])]}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={t('home.empty.mergeReady')}
                />
              ),
            }}
            renderItem={(item: Worktree) => (
              <List.Item
                className="dashboard-item"
                onClick={() =>
                  item.runId === undefined
                    ? navigate('runs')
                    : navigate('runs', { openRunId: item.runId })
                }
              >
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
          title={t('home.section.agentAvailability')}
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
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={t('home.empty.agentAvailability')}
                />
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
                      {t('home.availability.rateLimited')}
                    </Tag>
                  )}
                  <Tag
                    bordered={false}
                    color={item.available ? 'green' : item.installed ? 'gold' : 'red'}
                  >
                    {item.available
                      ? t('home.availability.available')
                      : item.installed
                        ? t('home.availability.unavailable')
                        : t('home.availability.notInstalled')}
                  </Tag>
                </Space>
              </List.Item>
            )}
          />
        </DashboardSection>

        <DashboardSection
          title={t('home.section.recentFailures')}
          count={recentFailures.data?.total}
          target="runs"
          block={recentFailures}
          onRetry={() => reloadBlock(workspace, 'recentFailures')}
        >
          <RunList
            runs={recentFailures.data?.items ?? []}
            statusTag={() => ({ color: 'red', label: t('home.run.failed') })}
            empty={t('home.empty.recentFailures')}
          />
        </DashboardSection>
      </div>
    </div>
  )
}
