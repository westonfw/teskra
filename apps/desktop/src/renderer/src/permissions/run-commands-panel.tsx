import { Alert, Button, Empty, Input, List, Space, Spin, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { AgentDefinition, AgentRun, PermissionDecision } from '@teskra/contracts'

import { useTranslation } from '../i18n'
import { usePermissionStore } from '../stores/permission-store'
import {
  canUseApprovalUi,
  elevatedEntries,
  permissionEnforcementInfo,
  riskTagColor,
} from './permission-view-model'

const DECISIONS: readonly PermissionDecision[] = [
  'allow-once',
  'allow-session',
  'always-allow',
  'deny',
]

interface DecisionPanelProps {
  readonly run: AgentRun
  readonly definition: AgentDefinition
}

/**
 * TASK-066 form A — approval decisions for `native` Agents. Honesty note
 * (ADR-0002): a decision is policy input consumed by the NEXT Run's
 * projection (or this app session); it cannot un-run a command that already
 * executed, and the in-terminal prompt of the CLI stays the live control.
 */
function PermissionDecisionPanel({ run, definition }: DecisionPanelProps) {
  const { t } = useTranslation()
  const resolveDecision = usePermissionStore((state) => state.resolveDecision)
  const [command, setCommand] = useState('')
  const [pending, setPending] = useState<PermissionDecision>()
  const [lastDecision, setLastDecision] = useState<string>()
  const decisionLabels: Record<PermissionDecision, string> = {
    'allow-once': t('permissions.decision.allowOnce'),
    'allow-session': t('permissions.decision.allowSession'),
    'always-allow': t('permissions.decision.alwaysAllow'),
    deny: t('permissions.decision.deny'),
  }

  const decide = async (decision: PermissionDecision): Promise<void> => {
    const pattern = command.trim()
    if (pattern.length === 0) return
    setPending(decision)
    const result = await resolveDecision({
      agentType: definition.id,
      commandPattern: pattern,
      decision,
      workspaceId: run.workspaceId,
      runId: run.id,
    })
    setPending(undefined)
    if (result !== undefined) {
      setLastDecision(
        result.persistedAs === 'rule'
          ? t(
              result.decision === 'deny'
                ? 'permissions.decision.savedDenyRule'
                : 'permissions.decision.savedAllowRule',
              { agent: definition.name },
            )
          : t('permissions.decision.heldSession'),
      )
    }
  }

  return (
    <Space direction="vertical" size={10} className="permission-decision-panel">
      <Typography.Text strong>{t('permissions.decision.title')}</Typography.Text>
      <Typography.Text type="secondary">
        {t('permissions.decision.description', { agent: definition.name })}
      </Typography.Text>
      <Input
        value={command}
        onChange={(event) => setCommand(event.target.value)}
        placeholder={t('permissions.decision.commandPlaceholder')}
      />
      <Space wrap>
        {DECISIONS.map((decision) => (
          <Button
            key={decision}
            size="small"
            danger={decision === 'deny'}
            loading={pending === decision}
            disabled={command.trim().length === 0}
            onClick={() => void decide(decision)}
          >
            {decisionLabels[decision]}
          </Button>
        ))}
      </Space>
      {lastDecision !== undefined && (
        <Typography.Text type="secondary">{lastDecision}</Typography.Text>
      )}
    </Space>
  )
}

/**
 * TASK-066 form B — the Commands tab: post-hoc audit of what the Run
 * executed (recognized from the output stream after the fact, ADR-0002),
 * with DESTRUCTIVE / NETWORK_WRITE pinned on top.
 */
export function RunCommandsPanel({
  run,
  definition,
}: {
  readonly run: AgentRun
  readonly definition?: AgentDefinition
}) {
  const entries = usePermissionStore((state) => state.audit)
  const loading = usePermissionStore((state) => state.loading)
  const startAuditSynchronization = usePermissionStore((state) => state.startAuditSynchronization)
  const { t } = useTranslation()

  useEffect(() => startAuditSynchronization(run.id), [run.id, startAuditSynchronization])

  const enforcement = definition?.permissionEnforcement ?? 'none'
  const info = permissionEnforcementInfo(enforcement, t)
  const elevated = elevatedEntries(entries)

  return (
    <Space direction="vertical" size={14} className="run-commands-panel">
      <Alert
        type="info"
        showIcon
        message={t('permissions.audit.recognizedNotice', { label: info.label })}
        description={info.description}
      />
      {elevated.length > 0 && (
        <Alert
          type="error"
          showIcon
          message={t(
            elevated.length === 1
              ? 'permissions.audit.elevatedOne'
              : 'permissions.audit.elevatedMany',
            { count: elevated.length },
          )}
          description={elevated.map((entry) => entry.command).join(' · ')}
        />
      )}
      {definition !== undefined && canUseApprovalUi(enforcement) && (
        <PermissionDecisionPanel run={run} definition={definition} />
      )}
      <Spin spinning={loading && entries.length === 0}>
        {entries.length === 0 && !loading ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('permissions.audit.empty')}
          />
        ) : (
          <List
            size="small"
            dataSource={[...entries]}
            renderItem={(entry) => (
              <List.Item>
                <Space direction="vertical" size={2}>
                  <Space>
                    <Tag color={riskTagColor(entry.riskLevel)}>{entry.riskLevel}</Tag>
                    <Typography.Text code>{entry.command}</Typography.Text>
                  </Space>
                  <Typography.Text type="secondary">
                    {t('permissions.audit.recognizedAt', {
                      time: new Date(entry.detectedAt).toLocaleString(),
                    })}
                    {entry.cwd === undefined ? '' : t('permissions.audit.cwd', { cwd: entry.cwd })}
                    {entry.matchedRuleId === undefined
                      ? ''
                      : t('permissions.audit.matchedRule', { id: entry.matchedRuleId })}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        )}
      </Spin>
    </Space>
  )
}
