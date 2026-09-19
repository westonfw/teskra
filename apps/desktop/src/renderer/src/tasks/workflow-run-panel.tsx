import { RocketOutlined } from '@ant-design/icons'
import {
  Alert,
  Button,
  Card,
  Collapse,
  Empty,
  Input,
  List,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import { useEffect, useState } from 'react'

import type {
  CriteriaReviewOutcome,
  CriterionResult,
  WorkflowRunStatus,
  WorkflowStepStatus,
} from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
import { useAgentStore } from '../stores/agent-store'
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

/** Runs still open (in flight or parked for the user); only these get a cancel action. */
const CANCELLABLE_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  'created',
  'running',
  'waiting',
  // Capped runs park here until the user either resumes iterating or closes
  // them — cancelling is the only "close the books" action that exists today.
  'needs_user_review',
])

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
  const cancelRun = useWorkflowRunStore((state) => state.cancelRun)
  const completeRun = useWorkflowRunStore((state) => state.completeRun)
  const clearError = useWorkflowRunStore((state) => state.clearError)
  const definitions = useAgentStore((state) => state.definitions)
  const loadDefinitions = useAgentStore((state) => state.loadDefinitions)
  const { t } = useTranslation()

  // Optional launch overrides; everything left empty resolves server-side
  // (AgentRegistry default roles → repo-local full.* definition, ADR-0005).
  const [launchOpen, setLaunchOpen] = useState(false)
  const [implementer, setImplementer] = useState<string | undefined>(undefined)
  const [reviewers, setReviewers] = useState<string[]>([])
  const [testCommand, setTestCommand] = useState('')

  useEffect(() => startSynchronization(taskId), [startSynchronization, taskId])
  useEffect(() => {
    if (launchOpen && definitions.length === 0) void loadDefinitions()
  }, [launchOpen, definitions.length, loadDefinitions])

  const agentOptions = definitions.map((definition) => ({
    value: definition.id,
    label: `${definition.name} (${definition.id})`,
  }))

  const confirmLaunch = async (): Promise<void> => {
    const command = testCommand.trim()
    const result = await startFullWorkflow({
      workspaceId,
      taskId,
      ...(implementer === undefined ? {} : { implementer }),
      ...(reviewers.length === 0 ? {} : { reviewers }),
      ...(command === '' ? {} : { testCommand: command }),
    })
    if (result !== undefined) setLaunchOpen(false)
  }

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
          onClick={() => setLaunchOpen(true)}
        >
          {t('workflow.start')}
        </Button>
      }
    >
      {error !== undefined && !launchOpen && (
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
                  ...(run.status === 'needs_user_review'
                    ? [
                        <a key="accept" onClick={() => void completeRun(run.id)}>
                          {t('workflow.accept')}
                        </a>,
                      ]
                    : []),
                  ...(CANCELLABLE_RUN_STATUSES.has(run.status)
                    ? [
                        <a key="cancel" onClick={() => void cancelRun(run.id)}>
                          {t('workflow.cancel')}
                        </a>,
                      ]
                    : []),
                  <a
                    key="toggle"
                    onClick={() => void selectRun(run.id === selectedId ? undefined : run.id)}
                  >
                    {run.id === selectedId ? t('workflow.hide') : t('workflow.view')}
                  </a>,
                ]}
              >
                <Space wrap>
                  <Tag color={runStatusColor[run.status] ?? 'default'}>
                    {run.status.replaceAll('_', ' ')}
                  </Tag>
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
      <Modal
        title={t('workflow.launch.title')}
        open={launchOpen}
        onCancel={() => setLaunchOpen(false)}
        onOk={() => void confirmLaunch()}
        okText={t('workflow.launch.confirm')}
        confirmLoading={starting}
        destroyOnHidden
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {/* Launch failures keep the modal open — surface the reason inside
              it, otherwise the page-level alert sits hidden behind the modal. */}
          {error !== undefined && <AppErrorAlert error={error} onClose={clearError} />}
          <Typography.Text type="secondary">{t('workflow.launch.hint')}</Typography.Text>
          <Typography.Text strong>{t('workflow.launch.implementer')}</Typography.Text>
          <Select
            style={{ width: '100%' }}
            allowClear
            options={agentOptions}
            value={implementer}
            placeholder={t('workflow.launch.implementerPlaceholder')}
            onChange={(value: string | undefined) => setImplementer(value)}
          />
          <Typography.Text strong>{t('workflow.launch.reviewers')}</Typography.Text>
          <Select
            style={{ width: '100%' }}
            mode="multiple"
            allowClear
            options={agentOptions}
            value={reviewers}
            placeholder={t('workflow.launch.reviewersPlaceholder')}
            onChange={(value: string[]) => setReviewers(value)}
          />
          <Typography.Text strong>{t('workflow.launch.testCommand')}</Typography.Text>
          <Input
            value={testCommand}
            placeholder={t('workflow.launch.testCommandPlaceholder')}
            onChange={(event) => setTestCommand(event.target.value)}
          />
        </Space>
      </Modal>
    </Card>
  )
}
