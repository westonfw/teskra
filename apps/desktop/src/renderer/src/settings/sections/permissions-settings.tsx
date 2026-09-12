import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd'
import { useEffect, useState } from 'react'

import type { PermissionAction, PermissionScope } from '@teskra/contracts'
import { PERMISSION_ACTIONS, PERMISSION_SCOPES } from '@teskra/contracts'

import { AppErrorAlert } from '../../components/app-error-alert'
import { useTranslation } from '../../i18n'
import {
  permissionEnforcementInfo,
  riskTagColor,
} from '../../permissions/permission-view-model'
import { useAgentStore } from '../../stores/agent-store'
import { usePermissionStore } from '../../stores/permission-store'
import { useWorkspaceStore } from '../../stores/workspace-store'

const RISK_LEVELS = [
  'READ_ONLY',
  'WORKSPACE_WRITE',
  'NETWORK_WRITE',
  'SYSTEM_WRITE',
  'DESTRUCTIVE',
  'UNKNOWN',
] as const

interface RuleDraft {
  commandPattern: string
  action: PermissionAction
  scope: PermissionScope
  workspaceId?: string
  agentType?: string
}

function ruleScopeLabel(workspaceId: string | undefined, agentType: string | undefined): string {
  return `${workspaceId ?? 'global'} · ${agentType ?? 'all agents'}`
}

/**
 * TASK-066 — Settings → Permissions: rule CRUD, per-Agent enforcement
 * explanations, and the filterable audit browser.
 */
export function PermissionsSettingsSection() {
  const rules = usePermissionStore((state) => state.rules)
  const audit = usePermissionStore((state) => state.audit)
  const loading = usePermissionStore((state) => state.loading)
  const error = usePermissionStore((state) => state.error)
  const loadRules = usePermissionStore((state) => state.loadRules)
  const createRule = usePermissionStore((state) => state.createRule)
  const updateRule = usePermissionStore((state) => state.updateRule)
  const deleteRule = usePermissionStore((state) => state.deleteRule)
  const loadAudit = usePermissionStore((state) => state.loadAudit)
  const clearError = usePermissionStore((state) => state.clearError)
  const definitions = useAgentStore((state) => state.definitions)
  const loadDefinitions = useAgentStore((state) => state.loadDefinitions)
  const workspaces = useWorkspaceStore((state) => state.recent)
  const { t } = useTranslation()

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<RuleDraft>({
    commandPattern: '',
    action: 'allow',
    scope: 'persistent',
  })
  const [auditWorkspaceId, setAuditWorkspaceId] = useState<string>()
  const [auditRiskLevel, setAuditRiskLevel] = useState<string>()
  const [auditRunId, setAuditRunId] = useState('')

  useEffect(() => {
    void loadRules()
    void loadDefinitions()
    void loadAudit()
  }, [loadAudit, loadDefinitions, loadRules])

  const saveRule = async (): Promise<void> => {
    setSaving(true)
    const succeeded =
      editingId === undefined
        ? await createRule({
            commandPattern: draft.commandPattern.trim(),
            action: draft.action,
            scope: draft.scope,
            ...(draft.workspaceId === undefined ? {} : { workspaceId: draft.workspaceId }),
            ...(draft.agentType === undefined ? {} : { agentType: draft.agentType }),
          })
        : await updateRule({
            ruleId: editingId,
            commandPattern: draft.commandPattern.trim(),
            action: draft.action,
            scope: draft.scope,
          })
    setSaving(false)
    if (succeeded) {
      setEditorOpen(false)
      setEditingId(undefined)
      setDraft({ commandPattern: '', action: 'allow', scope: 'persistent' })
    }
  }

  const openEditor = (ruleId?: string): void => {
    const existing = rules.find((rule) => rule.id === ruleId)
    setEditingId(existing?.id)
    setDraft(
      existing === undefined
        ? { commandPattern: '', action: 'allow', scope: 'persistent' }
        : {
            commandPattern: existing.commandPattern,
            action: existing.action,
            scope: existing.scope,
            ...(existing.workspaceId === undefined ? {} : { workspaceId: existing.workspaceId }),
            ...(existing.agentType === undefined ? {} : { agentType: existing.agentType }),
          },
    )
    setEditorOpen(true)
  }

  const applyAuditFilter = (): void => {
    void loadAudit({
      ...(auditWorkspaceId === undefined ? {} : { workspaceId: auditWorkspaceId }),
      ...(auditRiskLevel === undefined ? {} : { riskLevel: auditRiskLevel }),
      ...(auditRunId.trim().length === 0 ? {} : { runId: auditRunId.trim() }),
    })
  }

  return (
    <Space direction="vertical" size={18} className="settings-section-stack">
      <div>
        <Typography.Text className="settings-eyebrow">POLICY + AUDIT</Typography.Text>
        <Typography.Title level={3}>Permissions</Typography.Title>
        <Typography.Paragraph type="secondary">
          Teskra is a PTY host, not a syscall gateway (ADR-0002): rules are projected into each
          Agent CLI’s own approval mechanism before a Run starts, and the audit trail records
          commands after they were recognized in the output stream. Nothing here intercepts a
          command before it runs.
        </Typography.Paragraph>
      </div>
      {error !== undefined && <AppErrorAlert error={error} onClose={clearError} />}

      <Card title="Agent enforcement">
        <List
          size="small"
          dataSource={[...definitions]}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          renderItem={(definition) => {
            const info = permissionEnforcementInfo(definition.permissionEnforcement, t)
            return (
              <List.Item>
                <List.Item.Meta
                  title={
                    <Space>
                      <span>{definition.name}</span>
                      <Tag color={info.canPrompt ? 'green' : 'default'}>{info.mode}</Tag>
                    </Space>
                  }
                  description={info.description}
                />
              </List.Item>
            )
          }}
        />
      </Card>

      <Card
        title="Permission rules"
        extra={
          <Button icon={<PlusOutlined />} onClick={() => openEditor()}>
            New rule
          </Button>
        }
      >
        <Typography.Paragraph type="secondary">
          “ask” only prompts on Agents with native approval (see above); everywhere else it
          degrades to audit-only at projection time.
        </Typography.Paragraph>
        <Spin spinning={loading && rules.length === 0}>
          <List
            size="small"
            dataSource={[...rules]}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No rules yet" /> }}
            renderItem={(rule) => (
              <List.Item
                actions={[
                  <Button
                    key="edit"
                    type="text"
                    icon={<EditOutlined />}
                    onClick={() => openEditor(rule.id)}
                  />,
                  <Popconfirm
                    key="delete"
                    title="Delete this rule?"
                    onConfirm={() => void deleteRule(rule.id)}
                  >
                    <Button type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Typography.Text code>{rule.commandPattern}</Typography.Text>
                      <Tag color={rule.action === 'deny' ? 'red' : rule.action === 'allow' ? 'green' : 'gold'}>
                        {rule.action}
                      </Tag>
                      <Tag>{rule.scope}</Tag>
                    </Space>
                  }
                  description={ruleScopeLabel(rule.workspaceId, rule.agentType)}
                />
              </List.Item>
            )}
          />
        </Spin>
      </Card>

      <Card title="Audit log">
        <Space wrap className="permission-audit-filters">
          <Select
            allowClear
            placeholder="Workspace"
            value={auditWorkspaceId}
            onChange={(value: string | undefined) => setAuditWorkspaceId(value)}
            options={workspaces.map((workspace) => ({
              value: workspace.id,
              label: workspace.name,
            }))}
          />
          <Select
            allowClear
            placeholder="Risk level"
            value={auditRiskLevel}
            onChange={(value: string | undefined) => setAuditRiskLevel(value)}
            options={RISK_LEVELS.map((risk) => ({ value: risk, label: risk }))}
          />
          <Input
            allowClear
            placeholder="Run ID"
            value={auditRunId}
            onChange={(event) => setAuditRunId(event.target.value)}
          />
          <Button type="primary" onClick={applyAuditFilter}>
            Filter
          </Button>
        </Space>
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={[...audit]}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No audit entries" /> }}
          columns={[
            {
              title: 'Risk',
              dataIndex: 'riskLevel',
              width: 150,
              render: (risk: string) => <Tag color={riskTagColor(risk)}>{risk}</Tag>,
            },
            {
              title: 'Command',
              dataIndex: 'command',
              render: (command: string) => <Typography.Text code>{command}</Typography.Text>,
            },
            { title: 'Run', dataIndex: 'runId', width: 220, ellipsis: true },
            {
              title: 'Recognized at',
              dataIndex: 'detectedAt',
              width: 180,
              render: (at: string) => new Date(at).toLocaleString(),
            },
          ]}
        />
        <Alert
          className="permission-audit-note"
          type="info"
          showIcon
          message="“Recognized at” is when the command was detected in the output stream — after it already executed."
        />
      </Card>

      <Modal
        title={editingId === undefined ? 'New permission rule' : 'Edit permission rule'}
        open={editorOpen}
        confirmLoading={saving}
        okButtonProps={{ disabled: draft.commandPattern.trim().length === 0 }}
        onOk={() => void saveRule()}
        onCancel={() => setEditorOpen(false)}
      >
        <Space direction="vertical" size={12} className="permission-rule-form">
          <Input
            value={draft.commandPattern}
            onChange={(event) => setDraft({ ...draft, commandPattern: event.target.value })}
            placeholder="Command pattern, e.g. Bash(git push *) or git push"
            autoFocus
          />
          <Select<PermissionAction>
            value={draft.action}
            onChange={(action) => setDraft({ ...draft, action })}
            options={PERMISSION_ACTIONS.map((action) => ({ value: action, label: action }))}
          />
          <Select<PermissionScope>
            value={draft.scope}
            onChange={(scope) => setDraft({ ...draft, scope })}
            options={PERMISSION_SCOPES.map((scope) => ({ value: scope, label: scope }))}
          />
          <Select
            allowClear
            disabled={editingId !== undefined}
            placeholder="Workspace (empty = global)"
            value={draft.workspaceId}
            onChange={(value: string | undefined) =>
              setDraft({ ...draft, ...(value === undefined ? {} : { workspaceId: value }) })
            }
            options={workspaces.map((workspace) => ({
              value: workspace.id,
              label: workspace.name,
            }))}
          />
          <Select
            allowClear
            disabled={editingId !== undefined}
            placeholder="Agent (empty = all)"
            value={draft.agentType}
            onChange={(value: string | undefined) =>
              setDraft({ ...draft, ...(value === undefined ? {} : { agentType: value }) })
            }
            options={definitions.map((definition) => ({
              value: definition.id,
              label: definition.name,
            }))}
          />
        </Space>
      </Modal>
    </Space>
  )
}
