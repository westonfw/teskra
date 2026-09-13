import { CheckOutlined } from '@ant-design/icons'
import { Alert, Empty, Modal, Radio, Space, Spin, Tag, Typography } from 'antd'
import type { AgentAccountProfile, AgentRun } from '@teskra/contracts'
import { useEffect, useState } from 'react'

import { accountRuntimeLabel, accountStatusTag } from '../accounts/account-view-model'
import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
import { useAgentStore } from '../stores/agent-store'
import { useTaskStore } from '../stores/task-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import {
  continuationSourceStopFailed,
  groupContinuationCandidates,
} from './continuation-candidates'
import { useContinuationStore } from './continuation-store'

interface ContinueWithAccountModalProps {
  /** Called with the new target run after a successful continuation. */
  readonly onContinued: (run: AgentRun) => void
}

/**
 * TASK-108 (Milestone 24 §26) — "Continue <task> with" modal. Candidates are
 * split into a same-Agent and a cross-Agent section; both only list enabled,
 * runtime-compatible, currently usable (ready / unknown / expired-limit)
 * profiles. "Reuse current worktree" and "Carry handoff" are read-only
 * guarantees enforced by Main — there is no opt-out this round.
 */
export function ContinueWithAccountModal({ onContinued }: ContinueWithAccountModalProps) {
  const { t } = useTranslation()
  const open = useContinuationStore((state) => state.open)
  const sourceRun = useContinuationStore((state) => state.sourceRun)
  const profiles = useContinuationStore((state) => state.profiles)
  const refreshing = useContinuationStore((state) => state.refreshing)
  const submitting = useContinuationStore((state) => state.submitting)
  const error = useContinuationStore((state) => state.error)
  const continueWith = useContinuationStore((state) => state.continueWith)
  const close = useContinuationStore((state) => state.close)
  const clearError = useContinuationStore((state) => state.clearError)
  const workspace = useWorkspaceStore((state) => state.current)
  const definitions = useAgentStore((state) => state.definitions)
  const sourceTaskId = sourceRun?.taskId
  const taskTitle = useTaskStore((state) =>
    sourceTaskId === undefined
      ? undefined
      : state.tasks.find((task) => task.id === sourceTaskId)?.title,
  )
  const [selectedId, setSelectedId] = useState<string>()

  const sourceRunId = sourceRun?.id
  useEffect(() => {
    setSelectedId(undefined)
  }, [sourceRunId])

  const groups =
    sourceRun === undefined || workspace === undefined
      ? { sameAgent: [], crossAgent: [] }
      : groupContinuationCandidates(profiles, sourceRun, workspace.runtime, Date.now())
  const candidates = [...groups.sameAgent, ...groups.crossAgent]
  const agentName = (agentId: string): string =>
    definitions.find((definition) => definition.id === agentId)?.name ?? agentId

  const confirm = async (): Promise<void> => {
    const target = candidates.find((profile) => profile.id === selectedId)
    if (target === undefined) return
    const created = await continueWith(target.agentId, target.id)
    if (created !== undefined) onContinued(created)
  }

  const renderCandidate = (profile: AgentAccountProfile, showAgent: boolean) => {
    const status = accountStatusTag(profile, t)
    return (
      <Radio key={profile.id} value={profile.id} className="continuation-candidate">
        <Space size={8} wrap>
          <Typography.Text strong>{profile.name}</Typography.Text>
          {showAgent && <Tag>{agentName(profile.agentId)}</Tag>}
          <Tag color={status.color}>{status.label}</Tag>
          <Typography.Text type="secondary">{accountRuntimeLabel(profile.runtime)}</Typography.Text>
        </Space>
      </Radio>
    )
  }

  return (
    <Modal
      title={t('continueModal.title', { task: taskTitle ?? sourceRun?.agentType ?? '' })}
      open={open}
      onCancel={close}
      onOk={() => void confirm()}
      okText={t('continueModal.confirm')}
      okButtonProps={{ disabled: selectedId === undefined }}
      confirmLoading={submitting}
      destroyOnHidden
    >
      <Space direction="vertical" size={14} className="continuation-modal-body">
        {error !== undefined &&
          (continuationSourceStopFailed(error.code) ? (
            <Alert
              type="warning"
              showIcon
              closable
              message={t('continueModal.error.sourceNotStopped')}
              onClose={clearError}
            />
          ) : (
            <AppErrorAlert error={error} onClose={clearError} />
          ))}
        <Spin spinning={refreshing}>
          {candidates.length === 0 && !refreshing ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('continueModal.empty')} />
          ) : (
            <Radio.Group
              className="continuation-candidate-list"
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value as string)}
            >
              {groups.sameAgent.length > 0 && (
                <div className="continuation-candidate-section">
                  <Typography.Text type="secondary">
                    {t('continueModal.sameAgent', {
                      agent: agentName(sourceRun?.agentType ?? ''),
                    })}
                  </Typography.Text>
                  {groups.sameAgent.map((profile) => renderCandidate(profile, false))}
                </div>
              )}
              {groups.crossAgent.length > 0 && (
                <div className="continuation-candidate-section">
                  <Typography.Text type="secondary">
                    {t('continueModal.otherAgents')}
                  </Typography.Text>
                  {groups.crossAgent.map((profile) => renderCandidate(profile, true))}
                </div>
              )}
            </Radio.Group>
          )}
        </Spin>
        <Space direction="vertical" size={4}>
          <Typography.Text type="secondary">
            <CheckOutlined /> {t('continueModal.reuseWorktree')}
          </Typography.Text>
          <Typography.Text type="secondary">
            <CheckOutlined /> {t('continueModal.carryHandoff')}
          </Typography.Text>
        </Space>
      </Space>
    </Modal>
  )
}
