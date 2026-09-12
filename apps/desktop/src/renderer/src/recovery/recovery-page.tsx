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
import { useTranslation, type TranslationKey } from '../i18n'
import { useNavigationStore } from '../stores/navigation-store'
import { useRecoveryStore } from '../stores/recovery-store'
import { useWorkspaceStore } from '../stores/workspace-store'

const KIND_LABEL_KEYS: Record<RecoveryIssueKind, TranslationKey> = {
  interrupted_run: 'recovery.kind.interrupted_run',
  broken_worktree: 'recovery.kind.broken_worktree',
  dirty_worktree: 'recovery.kind.dirty_worktree',
  conflict: 'recovery.kind.conflict',
  stale_process: 'recovery.kind.stale_process',
}

const KIND_ORDER: readonly RecoveryIssueKind[] = [
  'interrupted_run',
  'broken_worktree',
  'dirty_worktree',
  'conflict',
  'stale_process',
]

export function RecoveryPage() {
  const { t } = useTranslation()
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
          <Typography.Text className="settings-eyebrow">{t('recovery.eyebrow')}</Typography.Text>
          <Typography.Title level={2}>{t('recovery.title')}</Typography.Title>
          <Typography.Paragraph type="secondary">{t('recovery.subtitle')}</Typography.Paragraph>
        </div>
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          disabled={workspaceId === undefined}
          onClick={() => workspaceId !== undefined && void load(workspaceId)}
        >
          {t('home.refresh')}
        </Button>
      </header>

      {error !== undefined && (
        <AppErrorAlert className="page-alert" error={error} onClose={clearError} />
      )}

      <Spin spinning={loading && issues.length === 0} tip={t('recovery.scanning')}>
        {issues.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('recovery.empty')} />
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
                      <Typography.Text strong>{t(KIND_LABEL_KEYS[kind])}</Typography.Text>
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
  const { t } = useTranslation()

  const busy = acting[issue.runId ?? issue.worktreeId ?? issue.id] === true
  const inspectTarget = issue.runId !== undefined ? 'runs' : 'git'

  const confirmDiscard = (): void => {
    if (issue.worktreeId === undefined) return
    const worktreeId = issue.worktreeId
    modal.confirm({
      title: t('worktree.discardConfirm.title'),
      content: t('recovery.discardConfirm.body'),
      okText: t('worktree.discard'),
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
                {t('runs.resume')}
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
                  {t('recovery.repair')}
                </Button>
                <Button size="small" danger disabled={busy} onClick={confirmDiscard}>
                  {t('recovery.discard')}
                </Button>
              </>
            )}
            <Button
              size="small"
              icon={<EyeOutlined />}
              disabled={busy}
              onClick={() => navigate(inspectTarget)}
            >
              {t('recovery.inspect')}
            </Button>
          </Space>
        }
      >
        {issue.detail !== undefined && (
          <Typography.Text type="secondary">{issue.detail}</Typography.Text>
        )}
        <Space size={[6, 6]} wrap className="doctor-related-ids">
          <Tag color="gold">{t(KIND_LABEL_KEYS[issue.kind])}</Tag>
          {issue.runId !== undefined && (
            <Typography.Text code>{t('artifacts.runId', { id: issue.runId })}</Typography.Text>
          )}
          {issue.worktreeId !== undefined && (
            <Typography.Text code>
              {t('recovery.worktreeId', { id: issue.worktreeId })}
            </Typography.Text>
          )}
        </Space>
      </Card>
    </List.Item>
  )
}
