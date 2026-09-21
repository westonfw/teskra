import { BellOutlined, ReloadOutlined } from '@ant-design/icons'
import { Button, Card, Empty, List, Popconfirm, Space, Spin, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { AgentRun, DecisionOption, PendingDecision } from '@teskra/contracts'

import { ContinueWithAccountModal } from '../agents/continue-with-account-modal'
import { useContinuationStore } from '../agents/continuation-store'
import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
import { useNavigationStore } from '../stores/navigation-store'
import {
  countOpenDecisions,
  decisionContextLinks,
  decisionDetailLines,
  decisionOptionLabel,
  decisionOptionNeedsConfirm,
  groupDecisionsBySeverity,
  isContinueWithAccountOption,
} from './decision-view-model'
import { useInboxStore } from './inbox-store'

/**
 * TASK-131 (teskra-tasks.md; design doc §9.3): the Decision Inbox page. Open
 * decisions from every source (shell confirmations, agent blockers, stalled
 * runs, merge blockers, rate limits, degraded handoffs) land here grouped by
 * severity; each item shows its source-context links and option buttons.
 * Danger options confirm twice; rate_limit's continue_with_account routes
 * through the TASK-108 ContinueWithAccountModal (Main only records the
 * resolution).
 */

const SEVERITY_COLORS: Record<PendingDecision['severity'], string> = {
  blocking: 'red',
  warning: 'gold',
  info: 'blue',
}

function ContextLinks({ decision }: { readonly decision: PendingDecision }) {
  const { t } = useTranslation()
  const navigate = useNavigationStore((state) => state.navigate)
  const links = decisionContextLinks(decision)
  if (links.length === 0) return null
  return (
    <Space size={8} wrap>
      {links.map((link) => (
        <Button
          key={link.labelKey}
          size="small"
          type="link"
          className="inbox-context-link"
          onClick={() =>
            link.openRunId === undefined
              ? navigate(link.page)
              : navigate(link.page, { openRunId: link.openRunId })
          }
        >
          {t(link.labelKey)}
        </Button>
      ))}
    </Space>
  )
}

function OptionButton({
  option,
  resolving,
  onPick,
}: {
  readonly option: DecisionOption
  readonly resolving: boolean
  readonly onPick: (option: DecisionOption) => void
}) {
  const { t } = useTranslation()
  const button = (
    <Button
      size="small"
      type={option.danger === true ? 'primary' : 'default'}
      danger={option.danger === true}
      disabled={resolving}
    >
      {decisionOptionLabel(option, t)}
    </Button>
  )
  if (!decisionOptionNeedsConfirm(option)) {
    return (
      <Button size="small" disabled={resolving} onClick={() => onPick(option)}>
        {decisionOptionLabel(option, t)}
      </Button>
    )
  }
  // danger options confirm twice (§9.3): the Popconfirm owns the action.
  return (
    <Popconfirm
      title={t('inbox.confirm.dangerTitle')}
      description={t('inbox.confirm.dangerBody', { action: decisionOptionLabel(option, t) })}
      okText={t('inbox.confirm.dangerOk')}
      cancelText={t('inbox.confirm.cancel')}
      okButtonProps={{ danger: true }}
      onConfirm={() => onPick(option)}
    >
      {button}
    </Popconfirm>
  )
}

export function InboxPage() {
  const { t } = useTranslation()
  const navigate = useNavigationStore((state) => state.navigate)
  const status = useInboxStore((state) => state.status)
  const decisions = useInboxStore((state) => state.decisions)
  const error = useInboxStore((state) => state.error)
  const resolvingId = useInboxStore((state) => state.resolvingId)
  const load = useInboxStore((state) => state.load)
  const resolve = useInboxStore((state) => state.resolve)
  const clearError = useInboxStore((state) => state.clearError)
  const openContinuation = useContinuationStore((state) => state.openFor)
  const [continuedDecisionId, setContinuedDecisionId] = useState<string>()

  useEffect(() => {
    void load()
  }, [load])

  const pick = async (decision: PendingDecision, option: DecisionOption): Promise<void> => {
    if (isContinueWithAccountOption(decision, option)) {
      // Main's continue_with_account is a recorded no-op; the renderer runs
      // the TASK-108 account-pick flow against the rate-limited source run.
      const runId = decision.runId
      if (runId === undefined) return
      const result = await window.teskra.agent.get({ runId })
      if (!result.ok || result.data === null) return
      setContinuedDecisionId(decision.id)
      openContinuation(result.data)
      return
    }
    await resolve(decision.id, option.id)
  }

  const onContinued = (run: AgentRun): void => {
    if (continuedDecisionId !== undefined) {
      void resolve(continuedDecisionId, 'continue_with_account')
      setContinuedDecisionId(undefined)
    }
    navigate('runs', { openRunId: run.id })
  }

  const groups = groupDecisionsBySeverity(decisions)
  const openCount = countOpenDecisions(decisions)

  return (
    <div className="workbench-page inbox-page">
      <header className="page-heading">
        <div>
          <Typography.Text className="settings-eyebrow">{t('inbox.eyebrow')}</Typography.Text>
          <Typography.Title level={2}>{t('inbox.title')}</Typography.Title>
          <Typography.Paragraph type="secondary">
            {t('inbox.subtitle', { count: openCount })}
          </Typography.Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void load()}>
          {t('inbox.refresh')}
        </Button>
      </header>

      {error !== undefined && <AppErrorAlert error={error} onClose={clearError} />}

      <Spin spinning={status === 'loading' && decisions.length === 0}>
        {groups.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('inbox.empty')}
            className="inbox-empty"
          />
        ) : (
          groups.map((group) => (
            <Card
              key={group.severity}
              size="small"
              className="inbox-group"
              title={
                <Space size={8}>
                  <BellOutlined />
                  <Typography.Text strong>{t(`inbox.severity.${group.severity}`)}</Typography.Text>
                  <Tag bordered={false} color={SEVERITY_COLORS[group.severity]}>
                    {group.decisions.length}
                  </Tag>
                </Space>
              }
            >
              <List
                size="small"
                dataSource={[...group.decisions]}
                renderItem={(decision) => (
                  <List.Item className="inbox-item" data-decision-id={decision.id}>
                    <div className="inbox-item-body">
                      <Space size={8} wrap>
                        <Typography.Text strong>{decision.title}</Typography.Text>
                        <Tag bordered={false}>{t(`inbox.kind.${decision.kind}`)}</Tag>
                        <Typography.Text type="secondary">
                          {new Date(decision.createdAt).toLocaleString()}
                        </Typography.Text>
                      </Space>
                      <div className="inbox-item-detail">
                        {decisionDetailLines(decision, t).map((line, index) =>
                          line.code === true ? (
                            <Typography.Paragraph
                              key={index}
                              copyable
                              code
                              className="inbox-detail-code"
                            >
                              {line.text}
                            </Typography.Paragraph>
                          ) : (
                            <Typography.Paragraph key={index} type="secondary">
                              {line.text}
                            </Typography.Paragraph>
                          ),
                        )}
                      </div>
                      <ContextLinks decision={decision} />
                      <Space size={8} wrap className="inbox-item-actions">
                        {decision.options.map((option) => (
                          <OptionButton
                            key={option.id}
                            option={option}
                            resolving={resolvingId === decision.id}
                            onPick={(picked) => void pick(decision, picked)}
                          />
                        ))}
                      </Space>
                    </div>
                  </List.Item>
                )}
              />
            </Card>
          ))
        )}
      </Spin>

      <ContinueWithAccountModal onContinued={onContinued} />
    </div>
  )
}
