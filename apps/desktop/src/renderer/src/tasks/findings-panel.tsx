import { Card, Empty, List, Space, Spin, Tag, Typography } from 'antd'
import { useEffect } from 'react'

import type { ReviewSeverity } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
import { sortFindingsBySeverity, useReviewStore } from '../stores/review-store'

/**
 * FindingsPanel (TASK-053) — the review findings a reviewer Run reported via
 * its WorkerHandoff (ADR-0004), grouped by severity color with file:line and
 * evidence where the Agent provided them.
 */

const severityColor: Record<ReviewSeverity, string> = {
  critical: 'red',
  high: 'volcano',
  medium: 'gold',
  low: 'blue',
}

interface FindingsPanelProps {
  readonly runId: string
}

export function FindingsPanel({ runId }: FindingsPanelProps) {
  const findings = useReviewStore((state) => state.findings)
  const loading = useReviewStore((state) => state.loading)
  const error = useReviewStore((state) => state.error)
  const startSynchronization = useReviewStore((state) => state.startSynchronization)
  const clearError = useReviewStore((state) => state.clearError)
  const { t } = useTranslation()

  useEffect(() => startSynchronization(runId), [startSynchronization, runId])

  return (
    <Card className="task-detail-card" title={t('findings.title', { count: findings.length })}>
      {error !== undefined && (
        <AppErrorAlert className="page-alert" error={error} onClose={clearError} />
      )}
      <Spin spinning={loading}>
        {findings.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('findings.empty')} />
        ) : (
          <List
            size="small"
            dataSource={sortFindingsBySeverity(findings)}
            renderItem={(finding) => (
              <List.Item>
                <Space direction="vertical" size={4} className="finding-item">
                  <Space wrap>
                    <Tag color={severityColor[finding.severity]}>{finding.severity}</Tag>
                    <Typography.Text strong>{finding.title}</Typography.Text>
                    {finding.file !== undefined && (
                      <Typography.Text code>
                        {finding.file}
                        {finding.line === undefined ? '' : `:${finding.line}`}
                      </Typography.Text>
                    )}
                    {finding.criterionId !== undefined && (
                      <Tag>{t('findings.criterion', { id: finding.criterionId })}</Tag>
                    )}
                  </Space>
                  {finding.description !== undefined && (
                    <Typography.Paragraph type="secondary" className="finding-detail">
                      {finding.description}
                    </Typography.Paragraph>
                  )}
                  {finding.evidence !== undefined && finding.evidence.length > 0 && (
                    <ul className="finding-evidence">
                      {finding.evidence.map((item) => (
                        <li key={item}>
                          <Typography.Text type="secondary">{item}</Typography.Text>
                        </li>
                      ))}
                    </ul>
                  )}
                </Space>
              </List.Item>
            )}
          />
        )}
      </Spin>
    </Card>
  )
}
