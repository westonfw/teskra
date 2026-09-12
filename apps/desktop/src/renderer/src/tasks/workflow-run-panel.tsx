import { RocketOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Collapse, Empty, List, Space, Spin, Tag, Typography } from 'antd'
import { useEffect } from 'react'

import type {
  CriteriaReviewOutcome,
  CriterionResult,
  WorkflowRunStatus,
  WorkflowStepStatus,
} from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
import { latestScoresByCriterion } from '../stores/review-store'
import { useWorkflowRunStore } from '../stores/workflow-run-store'

/**
 * WorkflowRunPanel (TASK-063) — the default Full Workflow on the Task page:
 * a one-click launch button, the live per-step status of the selected run
 * (fed by workflow.run_updated / workflow.step_updated), the round counter
 * under the plan §124 caps, an explicit "user review required" state when a
 * cap triggers, and the completion view — worktree branch diff vs base plus
 * the criteria scores of the anchored set.
 */

const runStatusColor: Partial<Record<WorkflowRunStatus, string>> = {
  created: 'default',
  running: 'cyan',
  waiting: 'blue',
  needs_user_review: 'gold',
  completed: 'green',
  failed: 'red',
  cancelled: 'default',
}

const stepStatusColor: Record<WorkflowStepStatus, string> = {
  pending: 'default',
  running: 'cyan',
  completed: 'green',
  failed: 'red',
  skipped: 'default',
  cancelled: 'default',
}

const outcomeColor: Record<CriteriaReviewOutcome, string> = {
  pass: 'green',
  fail: 'red',
  unknown: 'gold',
}

const scoreColor: Record<CriterionResult, string> = {
  pass: 'green',
  fail: 'red',
  unknown: 'default',
}

interface WorkflowRunPanelProps {
  readonly workspaceId: string
  readonly taskId: string
}

export function WorkflowRunPanel({ workspaceId, taskId }: WorkflowRunPanelProps) {
  const runs = useWorkflowRunStore((state) => state.runs)
  const selectedId = useWorkflowRunStore((state) => state.selectedId)
  const detail = useWorkflowRunStore((state) => state.detail)
  const summary = useWorkflowRunStore((state) => state.summary)
  const starting = useWorkflowRunStore((state) => state.starting)
  const loading = useWorkflowRunStore((state) => state.loading)
  const error = useWorkflowRunStore((state) => state.error)
  const startSynchronization = useWorkflowRunStore((state) => state.startSynchronization)
  const selectRun = useWorkflowRunStore((state) => state.selectRun)
  const startFullWorkflow = useWorkflowRunStore((state) => state.startFullWorkflow)
  const clearError = useWorkflowRunStore((state) => state.clearError)
  const { t } = useTranslation()

  useEffect(() => startSynchronization(taskId), [startSynchronization, taskId])

  const selected = detail !== undefined && detail.run.id === selectedId ? detail : undefined
  const scores = latestScoresByCriterion(summary?.criterionScores ?? [])

  return (
    <Card
      className="task-detail-card"
      title={t('workflow.title', { count: runs.length })}
      extra={
        <Button
          type="primary"
          icon={<RocketOutlined />}
          loading={starting}
          onClick={() => void startFullWorkflow({ workspaceId, taskId })}
        >
          {t('workflow.start')}
        </Button>
      }
    >
      {error !== undefined && (
        <AppErrorAlert className="page-alert" error={error} onClose={clearError} />
      )}
      <Spin spinning={loading}>
        {runs.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('workflow.empty')} />
        ) : (
          <List
            size="small"
            dataSource={[...runs]}
            renderItem={(run) => (
              <List.Item
                actions={[
                  <a
                    key="toggle"
                    onClick={() => void selectRun(run.id === selectedId ? undefined : run.id)}
                  >
                    {run.id === selectedId ? t('workflow.hide') : t('workflow.view')}
                  </a>,
                ]}
              >
                <Space wrap>
                  <Tag color={runStatusColor[run.status]}>{run.status.replaceAll('_', ' ')}</Tag>
                  <Typography.Text type="secondary">
                    {t('workflow.round', {
                      current: run.currentIteration + 1,
                      total: run.totalIterations,
                    })}
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    {new Date(run.createdAt).toLocaleString()}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        )}

        {selected !== undefined && (
          <Space direction="vertical" size={16} className="workflow-run-detail">
            {selected.run.status === 'needs_user_review' && (
              <Alert
                type="warning"
                showIcon
                message={t('workflow.limitReached.message')}
                description={t('workflow.limitReached.description')}
              />
            )}
            {selected.run.status === 'completed' && (
              <Alert
                type="success"
                showIcon
                message={t('workflow.passed.message')}
                description={t('workflow.passed.description')}
              />
            )}
            {selected.run.status === 'failed' && (
              <Alert type="error" showIcon message={t('workflow.failed')} />
            )}

            <List
              size="small"
              header={<Typography.Text strong>{t('workflow.steps')}</Typography.Text>}
              dataSource={[...selected.steps].sort(
                (a, b) => a.iteration - b.iteration || a.createdAt.localeCompare(b.createdAt),
              )}
              renderItem={(step) => (
                <List.Item>
                  <Space wrap>
                    <Typography.Text code>{step.nodeId}</Typography.Text>
                    <Tag>{step.nodeType}</Tag>
                    <Tag color={stepStatusColor[step.status]}>{step.status}</Tag>
                    <Typography.Text type="secondary">
                      {t('workflow.roundSingle', { n: step.iteration + 1 })}
                    </Typography.Text>
                  </Space>
                </List.Item>
              )}
            />

            {summary !== undefined && summary.run.id === selected.run.id && (
              <>
                {summary.worktree !== null && (
                  <Typography.Text type="secondary">
                    {t('workflow.worktreeLine', {
                      branch: summary.worktree.branch,
                      base: summary.worktree.baseBranch,
                    })}
                  </Typography.Text>
                )}

                {summary.diff !== null && summary.diff.files.length > 0 && (
                  <Collapse
                    size="small"
                    items={summary.diff.files.map((file) => ({
                      key: file.path,
                      label: (
                        <Space wrap>
                          <Typography.Text code>{file.path}</Typography.Text>
                          <Tag>{file.status}</Tag>
                          <Typography.Text type="success">{`+${String(file.additions)}`}</Typography.Text>
                          <Typography.Text type="danger">{`-${String(file.deletions)}`}</Typography.Text>
                        </Space>
                      ),
                      children: <pre className="workflow-diff-patch">{file.patch}</pre>,
                    }))}
                  />
                )}

                {summary.criteriaOutcome !== null && (
                  <Space direction="vertical" size={8}>
                    <Space wrap>
                      <Typography.Text strong>{t('workflow.criteriaResult')}</Typography.Text>
                      <Tag color={outcomeColor[summary.criteriaOutcome]}>
                        {summary.criteriaOutcome}
                      </Tag>
                    </Space>
                    <List
                      size="small"
                      dataSource={summary.criteria}
                      renderItem={(criterion) => (
                        <List.Item>
                          <Space wrap>
                            <Typography.Text>{criterion.description}</Typography.Text>
                            {criterion.required && <Tag color="red">{t('workflow.required')}</Tag>}
                            {scores.has(criterion.id) && (
                              <Tag
                                color={scoreColor[scores.get(criterion.id)?.result ?? 'unknown']}
                              >
                                {scores.get(criterion.id)?.result}
                              </Tag>
                            )}
                          </Space>
                        </List.Item>
                      )}
                    />
                  </Space>
                )}
              </>
            )}
          </Space>
        )}
      </Spin>
    </Card>
  )
}
