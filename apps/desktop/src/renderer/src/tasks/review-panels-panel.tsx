import { Alert, Card, Empty, List, Space, Spin, Tag, Typography } from 'antd'
import { useEffect } from 'react'

import type {
  ReviewDisagreement,
  ReviewPanel,
  ReviewPanelVerdict,
  ReviewSeverity,
  ReviewVerdict,
} from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { sortFindingsBySeverity } from '../stores/review-store'
import { useReviewPanelStore } from '../stores/review-panel-store'

/**
 * ReviewPanelsPanel (TASK-061) — the Review Aggregator's output for one Task:
 * each panel's severity-policy verdict, the policy reasons, per-reviewer
 * summaries, findings grouped by severity, and the disagreements between
 * reviewers (explicitly preserved, never majority-collapsed).
 */

const severityColor: Record<ReviewSeverity, string> = {
  critical: 'red',
  high: 'volcano',
  medium: 'gold',
  low: 'blue',
}

const verdictColor: Record<ReviewPanelVerdict, string> = {
  pass: 'green',
  block: 'red',
}

const memberVerdictColor: Record<ReviewVerdict, string> = {
  approve: 'green',
  changes_requested: 'volcano',
  unable_to_review: 'default',
}

function VerdictTag({ panel }: { readonly panel: ReviewPanel }) {
  if (panel.status === 'running') return <Tag color="blue">running</Tag>
  if (panel.status === 'failed') return <Tag>failed</Tag>
  const verdict = panel.aggregate?.verdict
  if (verdict === undefined) return <Tag color="gold">no verdict</Tag>
  return <Tag color={verdictColor[verdict]}>{verdict === 'pass' ? 'PASS' : 'BLOCK'}</Tag>
}

function DisagreementItem({ disagreement }: { readonly disagreement: ReviewDisagreement }) {
  return (
    <List.Item>
      <Space direction="vertical" size={4}>
        <Space wrap>
          <Tag color="orange">disagreement</Tag>
          <Typography.Text strong>{disagreement.kind}</Typography.Text>
          <Typography.Text code>{disagreement.subject}</Typography.Text>
        </Space>
        <Typography.Text type="secondary">
          {disagreement.positions
            .map((position) => `${position.agentId}: ${position.position}`)
            .join(' · ')}
        </Typography.Text>
      </Space>
    </List.Item>
  )
}

interface ReviewPanelsPanelProps {
  readonly taskId: string
}

export function ReviewPanelsPanel({ taskId }: ReviewPanelsPanelProps) {
  const panels = useReviewPanelStore((state) => state.panels)
  const selectedId = useReviewPanelStore((state) => state.selectedId)
  const detail = useReviewPanelStore((state) => state.detail)
  const loading = useReviewPanelStore((state) => state.loading)
  const error = useReviewPanelStore((state) => state.error)
  const startSynchronization = useReviewPanelStore((state) => state.startSynchronization)
  const selectPanel = useReviewPanelStore((state) => state.selectPanel)
  const clearError = useReviewPanelStore((state) => state.clearError)

  useEffect(() => startSynchronization(taskId), [startSynchronization, taskId])

  const aggregate = detail?.panel.aggregate

  return (
    <Card className="task-detail-card" title={`Review panels · ${panels.length}`}>
      {error !== undefined && (
        <AppErrorAlert className="page-alert" error={error} onClose={clearError} />
      )}
      <Spin spinning={loading}>
        {panels.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No review panels yet" />
        ) : (
          <List
            size="small"
            dataSource={[...panels]}
            renderItem={(panel) => (
              <List.Item
                actions={[
                  <a
                    key="toggle"
                    onClick={() =>
                      void selectPanel(panel.id === selectedId ? undefined : panel.id)
                    }
                  >
                    {panel.id === selectedId ? 'Hide' : 'View'}
                  </a>,
                ]}
              >
                <Space wrap>
                  <VerdictTag panel={panel} />
                  {panel.consensus !== undefined && <Tag>{panel.consensus}</Tag>}
                  <Typography.Text type="secondary">
                    {new Date(panel.createdAt).toLocaleString()}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        )}

        {detail !== undefined && detail.panel.id === selectedId && (
          <Space direction="vertical" size={16} className="review-panel-detail">
            {aggregate?.verdict !== undefined && (
              <Alert
                type={aggregate.verdict === 'pass' ? 'success' : 'error'}
                showIcon
                message={aggregate.verdict === 'pass' ? 'PASS' : 'BLOCK'}
                description={
                  <ul className="review-panel-reasons">
                    {(aggregate.reasons ?? []).map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                }
              />
            )}

            {aggregate !== undefined && aggregate.reviewers.length > 0 && (
              <List
                size="small"
                header={<Typography.Text strong>Reviewers</Typography.Text>}
                dataSource={aggregate.reviewers}
                renderItem={(reviewer) => (
                  <List.Item>
                    <Space wrap>
                      <Typography.Text strong>{reviewer.agentId}</Typography.Text>
                      <Tag color={memberVerdictColor[reviewer.verdict]}>{reviewer.verdict}</Tag>
                      <Tag>{reviewer.isolation}</Tag>
                      <Typography.Text type="secondary">
                        {`${String(reviewer.findings.critical)} critical · ${String(reviewer.findings.high)} high · ${String(reviewer.findings.medium)} medium · ${String(reviewer.findings.low)} low`}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            )}

            {aggregate !== undefined && aggregate.disagreements.length > 0 && (
              <List
                size="small"
                header={<Typography.Text strong>Disagreements</Typography.Text>}
                dataSource={aggregate.disagreements}
                renderItem={(disagreement) => <DisagreementItem disagreement={disagreement} />}
              />
            )}

            {aggregate !== undefined && aggregate.findings.length > 0 && (
              <List
                size="small"
                header={<Typography.Text strong>{`Findings · ${aggregate.findings.length}`}</Typography.Text>}
                dataSource={sortFindingsBySeverity(aggregate.findings)}
                renderItem={(finding) => (
                  <List.Item>
                    <Space wrap>
                      <Tag color={severityColor[finding.severity]}>{finding.severity}</Tag>
                      <Typography.Text>{finding.title}</Typography.Text>
                      {finding.file !== undefined && (
                        <Typography.Text code>
                          {finding.file}
                          {finding.line === undefined ? '' : `:${finding.line}`}
                        </Typography.Text>
                      )}
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Space>
        )}
      </Spin>
    </Card>
  )
}
