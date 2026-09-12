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
import { useTranslation, type TranslationKey } from '../../i18n'
import { permissionEnforcementInfo, riskTagColor } from '../../permissions/permission-view-model'
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

type Translate = (key: TranslationKey) => string

interface RuleDraft {
  commandPattern: string
  action: PermissionAction
  scope: PermissionScope
  workspaceId?: string
  agentType?: string
}

function ruleScopeLabel(
  t: Translate,
  workspaceId: string | undefined,
  agentType: string | undefined,
): string {
  return `${workspaceId ?? t('settings.permissions.scope.global')} · ${agentType ?? t('settings.permissions.scope.allAgents')}`
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
        <Typography.Text className="settings-eyebrow">
          {t('settings.permissions.eyebrow')}
        </Typography.Text>
        <Typography.Title level={3}>{t('settings.section.permissions.title')}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {t('settings.permissions.subtitle')}
        </Typography.Paragraph>
      </div>
      {error !== undefined && <AppErrorAlert error={error} onClose={clearError} />}

      <Card title={t('settings.permissions.enforcement.title')}>
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
        title={t('settings.permissions.rules.title')}
        extra={
          <Button icon={<PlusOutlined />} onClick={() => openEditor()}>
            {t('settings.permissions.rules.new')}
          </Button>
        }
      >
        <Typography.Paragraph type="secondary">
          {t('settings.permissions.rules.askNote')}
        </Typography.Paragraph>
        <Spin spinning={loading && rules.length === 0}>
          <List
            size="small"
            dataSource={[...rules]}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={t('settings.permissions.rules.empty')}
                />
              ),
            }}
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
                    title={t('settings.permissions.rules.deleteConfirm')}
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
                      <Tag
                        color={
                          rule.action === 'deny'
                            ? 'red'
                            : rule.action === 'allow'
                              ? 'green'
                              : 'gold'
                        }
                      >
                        {rule.action}
                      </Tag>
                      <Tag>{rule.scope}</Tag>
                    </Space>
                  }
                  description={ruleScopeLabel(t, rule.workspaceId, rule.agentType)}
                />
              </List.Item>
            )}
          />
        </Spin>
      </Card>

      <Card title={t('settings.permissions.audit.title')}>
        <Space wrap className="permission-audit-filters">
          <Select
            allowClear
            placeholder={t('settings.layer.workspace')}
            value={auditWorkspaceId}
            onChange={(value: string | undefined) => setAuditWorkspaceId(value)}
            options={workspaces.map((workspace) => ({
              value: workspace.id,
              label: workspace.name,
            }))}
          />
          <Select
            allowClear
            placeholder={t('settings.permissions.audit.riskLevel')}
            value={auditRiskLevel}
            onChange={(value: string | undefined) => setAuditRiskLevel(value)}
            options={RISK_LEVELS.map((risk) => ({ value: risk, label: risk }))}
          />
          <Input
            allowClear
            placeholder={t('runs.field.runId')}
            value={auditRunId}
            onChange={(event) => setAuditRunId(event.target.value)}
          />
          <Button type="primary" onClick={applyAuditFilter}>
            {t('settings.permissions.audit.filter')}
          </Button>
        </Space>
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={[...audit]}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t('settings.permissions.audit.empty')}
              />
            ),
          }}
          columns={[
            {
              title: t('settings.permissions.audit.column.risk'),
              dataIndex: 'riskLevel',
              width: 150,
              render: (risk: string) => <Tag color={riskTagColor(risk)}>{risk}</Tag>,
            },
            {
              title: t('settings.permissions.audit.column.command'),
              dataIndex: 'command',
              render: (command: string) => <Typography.Text code>{command}</Typography.Text>,
            },
            {
              title: t('settings.permissions.audit.column.run'),
              dataIndex: 'runId',
              width: 220,
              ellipsis: true,
            },
            {
              title: t('settings.permissions.audit.column.recognizedAt'),
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
          message={t('settings.permissions.audit.recognizedNote')}
        />
      </Card>

      <Modal
        title={
          editingId === undefined
            ? t('settings.permissions.rule.new')
            : t('settings.permissions.rule.edit')
        }
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
            placeholder={t('settings.permissions.rule.commandPatternPlaceholder')}
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
            placeholder={t('settings.permissions.rule.workspacePlaceholder')}
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
            placeholder={t('settings.permissions.rule.agentPlaceholder')}
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
