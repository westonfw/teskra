import { Alert, Button, Empty, Input, List, Space, Spin, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { AgentDefinition, AgentRun, PermissionDecision } from '@teskra/contracts'

import { usePermissionStore } from '../stores/permission-store'
import {
  canUseApprovalUi,
  elevatedEntries,
  permissionEnforcementInfo,
  riskTagColor,
} from './permission-view-model'

const DECISION_LABELS: Record<PermissionDecision, string> = {
  'allow-once': 'Allow Once',
  'allow-session': 'Allow Session',
  'always-allow': 'Always Allow',
  deny: 'Deny',
}

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
  const resolveDecision = usePermissionStore((state) => state.resolveDecision)
  const [command, setCommand] = useState('')
  const [pending, setPending] = useState<PermissionDecision>()
  const [lastDecision, setLastDecision] = useState<string>()

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
          ? `Saved as a persistent ${result.decision === 'deny' ? 'deny' : 'allow'} rule — it applies to the next ${definition.name} run in this workspace.`
          : 'Held for this app session — it applies to the next policy projection.',
      )
    }
  }

  return (
    <Space direction="vertical" size={10} className="permission-decision-panel">
      <Typography.Text strong>Approval decisions</Typography.Text>
      <Typography.Text type="secondary">
        {definition.name} asks for approval in its own terminal prompt. Decisions made here
        update the rules projected into the CLI before the next Run — they do not affect a
        command that is already executing.
      </Typography.Text>
      <Input
        value={command}
        onChange={(event) => setCommand(event.target.value)}
        placeholder="Command pattern, e.g. Bash(npm test)"
      />
      <Space wrap>
        {(Object.keys(DECISION_LABELS) as PermissionDecision[]).map((decision) => (
          <Button
            key={decision}
            size="small"
            danger={decision === 'deny'}
            loading={pending === decision}
            disabled={command.trim().length === 0}
            onClick={() => void decide(decision)}
          >
            {DECISION_LABELS[decision]}
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

  useEffect(() => startAuditSynchronization(run.id), [run.id, startAuditSynchronization])

  const enforcement = definition?.permissionEnforcement ?? 'none'
  const info = permissionEnforcementInfo(enforcement)
  const elevated = elevatedEntries(entries)

  return (
    <Space direction="vertical" size={14} className="run-commands-panel">
      <Alert
        type="info"
        showIcon
        message={`${info.label} — commands listed here were recognized after they ran`}
        description={info.description}
      />
      {elevated.length > 0 && (
        <Alert
          type="error"
          showIcon
          message={`This Run executed ${elevated.length} high-risk command${elevated.length === 1 ? '' : 's'}`}
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
            description="No commands recognized in this Run’s output yet"
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
                    Recognized at {new Date(entry.detectedAt).toLocaleString()}
                    {entry.cwd === undefined ? '' : ` · cwd ${entry.cwd}`}
                    {entry.matchedRuleId === undefined
                      ? ''
                      : ` · matched rule ${entry.matchedRuleId}`}
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
