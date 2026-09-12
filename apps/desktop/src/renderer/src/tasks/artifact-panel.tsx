import { FileSearchOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, List, Modal, Space, Spin, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { Artifact, ArtifactContent } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
import { useArtifactStore } from '../stores/artifact-store'

/**
 * ArtifactsPanel (TASK-050) — read-only viewer for a Task's Artifacts.
 *
 * Lists every Artifact attached to the Task; clicking one resolves its
 * payload (inline text, file contents, or metadata JSON) in a Modal.
 * "Scan run artifacts" indexes files Agents dropped into their artifact
 * directories (ADR-0004) without registering them.
 */

interface ArtifactPanelProps {
  readonly taskId: string
  /** Runs of this Task whose artifact directories can be scanned. */
  readonly runIds: readonly string[]
}

export function ArtifactPanel({ taskId, runIds }: ArtifactPanelProps) {
  const artifacts = useArtifactStore((state) => state.artifacts)
  const loading = useArtifactStore((state) => state.loading)
  const scanning = useArtifactStore((state) => state.scanning)
  const error = useArtifactStore((state) => state.error)
  const startSynchronization = useArtifactStore((state) => state.startSynchronization)
  const loadContent = useArtifactStore((state) => state.loadContent)
  const scanRuns = useArtifactStore((state) => state.scanRuns)
  const clearError = useArtifactStore((state) => state.clearError)
  const { t } = useTranslation()

  const [opened, setOpened] = useState<ArtifactContent>()
  const [contentLoading, setContentLoading] = useState(false)

  useEffect(() => startSynchronization(taskId), [startSynchronization, taskId])

  const handleOpen = async (artifact: Artifact): Promise<void> => {
    setContentLoading(true)
    const content = await loadContent(artifact.id)
    setContentLoading(false)
    if (content !== undefined) setOpened(content)
  }

  return (
    <Card
      className="task-detail-card"
      title={t('artifacts.title', { count: artifacts.length })}
      extra={
        runIds.length > 0 && (
          <Button
            size="small"
            icon={<FileSearchOutlined />}
            loading={scanning}
            onClick={() => void scanRuns(runIds)}
          >
            {t('artifacts.scan')}
          </Button>
        )
      }
    >
      {error !== undefined && (
        <AppErrorAlert className="page-alert" error={error} onClose={clearError} />
      )}
      <Spin spinning={loading || contentLoading}>
        {artifacts.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('artifacts.empty')} />
        ) : (
          <List
            size="small"
            dataSource={[...artifacts]}
            renderItem={(artifact) => (
              <List.Item
                actions={[
                  <Button key="view" type="link" onClick={() => void handleOpen(artifact)}>
                    {t('artifacts.view')}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <span>{artifact.name}</span>
                      <Tag>{artifact.type}</Tag>
                    </Space>
                  }
                  description={new Date(artifact.createdAt).toLocaleString()}
                />
              </List.Item>
            )}
          />
        )}
      </Spin>

      <Modal
        title={opened?.artifact.name ?? t('artifacts.fallbackTitle')}
        width={720}
        open={opened !== undefined}
        footer={null}
        onCancel={() => setOpened(undefined)}
      >
        {opened !== undefined && (
          <Space direction="vertical" size={12} className="artifact-detail">
            <Space wrap>
              <Tag>{opened.artifact.type}</Tag>
              {opened.artifact.runId !== undefined && (
                <Typography.Text type="secondary">
                  {t('artifacts.runId', { id: opened.artifact.runId })}
                </Typography.Text>
              )}
              {opened.artifact.filePath !== undefined && (
                <Typography.Text code>{opened.artifact.filePath}</Typography.Text>
              )}
            </Space>
            {opened.truncated && <Alert type="info" showIcon message={t('artifacts.truncated')} />}
            {opened.content.length === 0 ? (
              <Typography.Text type="secondary">{t('artifacts.noContent')}</Typography.Text>
            ) : (
              <pre className="artifact-content">{opened.content}</pre>
            )}
          </Space>
        )}
      </Modal>
    </Card>
  )
}
