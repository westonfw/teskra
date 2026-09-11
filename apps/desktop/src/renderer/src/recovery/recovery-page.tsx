import {
  EyeOutlined,
  MedicineBoxOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  ToolOutlined,
} from '@ant-design/icons'
import { App as AntApp, Button, Card, Empty, List, Space, Spin, Tag, Typography } from 'antd'
import { useEffect } from 'react'

import type { RecoveryIssue, RecoveryIssueKind } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useNavigationStore } from '../stores/navigation-store'
import { useRecoveryStore } from '../stores/recovery-store'
import { useWorkspaceStore } from '../stores/workspace-store'

const KIND_LABELS: Record<RecoveryIssueKind, string> = {
  interrupted_run: 'Interrupted Runs',
  broken_worktree: 'Broken Worktrees',
  dirty_worktree: 'Dirty Worktrees',
  conflict: 'Conflicts',
  stale_process: 'Stale Processes',
}

const KIND_ORDER: readonly RecoveryIssueKind[] = [
  'interrupted_run',
  'broken_worktree',
  'dirty_worktree',
  'conflict',
  'stale_process',
]

export function RecoveryPage() {
  const workspace = useWorkspaceStore((state) => state.current)
  const issues = useRecoveryStore((state) => state.issues)
  const loading = useRecoveryStore((state) => state.loading)
  const error = useRecoveryStore((state) => state.error)
  const clearError = useRecoveryStore((state) => state.clearError)
  const load = useRecoveryStore((state) => state.load)
  const startSynchronization = useRecoveryStore((state) => state.startSynchronization)

  const workspaceId = workspace?.id
  useEffect(() => {
    if (workspaceId === undefined) return
    return startSynchronization(workspaceId)
  }, [workspaceId, startSynchronization])

  return (
    <div className="workbench-page recovery-page">
      <header className="page-heading">
        <div>
          <Typography.Text className="settings-eyebrow">CRASH RECOVERY</Typography.Text>
          <Typography.Title level={2}>Recovery Center</Typography.Title>
          <Typography.Paragraph type="secondary">
            Interrupted runs, broken worktrees, and stale processes — each with a suggested next
            step.
          </Typography.Paragraph>
        </div>
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          disabled={workspaceId === undefined}
          onClick={() => workspaceId !== undefined && void load(workspaceId)}
        >
          Refresh
        </Button>
      </header>

      {error !== undefined && (
        <AppErrorAlert className="page-alert" error={error} onClose={clearError} />
      )}

      <Spin spinning={loading && issues.length === 0} tip="Scanning for recoverable issues…">
        {issues.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Everything is healthy — nothing to recover."
          />
        ) : (
          <Space direction="vertical" size={18} className="doctor-report">
            {KIND_ORDER.map((kind) => {
              const group = issues.filter((item) => item.kind === kind)
              if (group.length === 0) return null
              return (
                <List
                  key={kind}
                  className="doctor-check-list"
                  header={
                    <Space>
                      <MedicineBoxOutlined />
                      <Typography.Text strong>{KIND_LABELS[kind]}</Typography.Text>
                      <Tag bordered={false}>{group.length}</Tag>
                    </Space>
                  }
                  dataSource={group}
                  renderItem={(item) =>
                    workspaceId === undefined ? null : (
                      <RecoveryIssueItem workspaceId={workspaceId} issue={item} />
                    )
                  }
                />
              )
            })}
          </Space>
        )}
      </Spin>
    </div>
  )
}

function RecoveryIssueItem({
  workspaceId,
  issue,
}: {
  readonly workspaceId: string
  readonly issue: RecoveryIssue
}) {
  const acting = useRecoveryStore((state) => state.acting)
  const resumeRun = useRecoveryStore((state) => state.resumeRun)
  const repairWorktree = useRecoveryStore((state) => state.repairWorktree)
  const discardWorktree = useRecoveryStore((state) => state.discardWorktree)
  const navigate = useNavigationStore((state) => state.navigate)
  const { modal } = AntApp.useApp()

  const busy = acting[issue.runId ?? issue.worktreeId ?? issue.id] === true
  const inspectTarget = issue.runId !== undefined ? 'runs' : 'git'

  const confirmDiscard = (): void => {
    if (issue.worktreeId === undefined) return
    const worktreeId = issue.worktreeId
    modal.confirm({
      title: 'Discard this worktree?',
      content:
        'This permanently deletes the worktree directory and its uncommitted changes. The agent branch and its commits are kept.',
      okText: 'Discard',
      okButtonProps: { danger: true },
      onOk: () => discardWorktree(workspaceId, worktreeId),
    })
  }

  return (
    <List.Item>
      <Card
        size="small"
        className="doctor-check-card"
        title={<span>{issue.summary}</span>}
        extra={
          <Space>
            {issue.suggestedAction === 'resume' && issue.runId !== undefined && (
              <Button
                type="primary"
                size="small"
                icon={<PlayCircleOutlined />}
                loading={busy}
                onClick={() => void resumeRun(workspaceId, issue.runId as string)}
              >
                Resume
              </Button>
            )}
            {issue.suggestedAction === 'repair' && issue.worktreeId !== undefined && (
              <>
                <Button
                  type="primary"
                  size="small"
                  icon={<ToolOutlined />}
                  loading={busy}
                  onClick={() => void repairWorktree(workspaceId, issue.worktreeId as string)}
                >
                  Repair
                </Button>
                <Button size="small" danger disabled={busy} onClick={confirmDiscard}>
                  Discard…
                </Button>
              </>
            )}
            <Button
              size="small"
              icon={<EyeOutlined />}
              disabled={busy}
              onClick={() => navigate(inspectTarget)}
            >
              Inspect
            </Button>
          </Space>
        }
      >
        {issue.detail !== undefined && (
          <Typography.Text type="secondary">{issue.detail}</Typography.Text>
        )}
        <Space size={[6, 6]} wrap className="doctor-related-ids">
          <Tag color="gold">{KIND_LABELS[issue.kind]}</Tag>
          {issue.runId !== undefined && <Typography.Text code>run {issue.runId}</Typography.Text>}
          {issue.worktreeId !== undefined && (
            <Typography.Text code>worktree {issue.worktreeId}</Typography.Text>
          )}
        </Space>
      </Card>
    </List.Item>
  )
}

