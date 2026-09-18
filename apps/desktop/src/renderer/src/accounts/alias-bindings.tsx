import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { Button, Card, Empty, Input, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'

import type { ProfileAlias, ProfileAliasKind } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
import { useAgentStore } from '../stores/agent-store'
import { useProfileAliasStore } from './profile-alias-store'

/**
 * TASK-111 (§22/§53.1) — Settings → Accounts → Aliases.
 *
 * Aliases are the ONLY way a repo-committed workflow references a profile
 * (`accountProfile: work` / `profile: high-work`); the binding to a
 * machine-local Profile happens here and never enters the repo (ADR-0011).
 */
export function AliasBindingsCard() {
  const { t } = useTranslation()
  const aliases = useProfileAliasStore((state) => state.aliases)
  const accountProfiles = useProfileAliasStore((state) => state.accountProfiles)
  const executionProfiles = useProfileAliasStore((state) => state.executionProfiles)
  const loading = useProfileAliasStore((state) => state.loading)
  const error = useProfileAliasStore((state) => state.error)
  const refresh = useProfileAliasStore((state) => state.refresh)
  const bindAlias = useProfileAliasStore((state) => state.bindAlias)
  const unbindAlias = useProfileAliasStore((state) => state.unbindAlias)
  const clearError = useProfileAliasStore((state) => state.clearError)
  const definitions = useAgentStore((state) => state.definitions)
  const loadDefinitions = useAgentStore((state) => state.loadDefinitions)

  const [adding, setAdding] = useState(false)
  const [agentId, setAgentId] = useState<string>()
  const [kind, setKind] = useState<ProfileAliasKind>('account')
  const [alias, setAlias] = useState('')
  const [profileId, setProfileId] = useState<string>()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void refresh()
    if (definitions.length === 0) void loadDefinitions()
  }, [refresh, definitions.length, loadDefinitions])

  // The bind target picker lists only profiles of the selected agent + kind —
  // anything else is rejected Main-side (§28), so don't offer it.
  const profileOptions = useMemo(() => {
    if (agentId === undefined) return []
    return (kind === 'account' ? accountProfiles : executionProfiles)
      .filter((profile) => profile.agentId === agentId)
      .map((profile) => ({ value: profile.id, label: profile.name }))
  }, [agentId, kind, accountProfiles, executionProfiles])

  const agentOptions = useMemo(() => {
    const known = definitions.map((definition) => ({
      value: definition.id,
      label: definition.name,
    }))
    const knownIds = new Set(definitions.map((definition) => definition.id))
    const extra = [
      ...new Set([
        ...accountProfiles.map((profile) => profile.agentId),
        ...executionProfiles.map((profile) => profile.agentId),
      ]),
    ]
      .filter((id) => !knownIds.has(id))
      .map((id) => ({ value: id, label: id }))
    return [...known, ...extra]
  }, [definitions, accountProfiles, executionProfiles])

  const profileName = (binding: ProfileAlias): string => {
    const profiles = binding.kind === 'account' ? accountProfiles : executionProfiles
    return (
      profiles.find((profile) => profile.id === binding.profileId)?.name ??
      t('aliases.targetMissing')
    )
  }

  const submit = async (): Promise<void> => {
    if (agentId === undefined || profileId === undefined || alias.trim().length === 0) return
    setSaving(true)
    const bound = await bindAlias({
      agentId,
      kind,
      alias: alias.trim(),
      profileId,
    })
    setSaving(false)
    if (bound !== undefined) {
      setAdding(false)
      setAlias('')
      setProfileId(undefined)
    }
  }

  return (
    <Card
      title={t('aliases.title')}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
          {t('aliases.add')}
        </Button>
      }
    >
      <Space direction="vertical" size={12} className="alias-bindings-body">
        <Typography.Paragraph type="secondary">{t('aliases.subtitle')}</Typography.Paragraph>
        {error !== undefined && <AppErrorAlert error={error} onClose={clearError} />}
        <Table<ProfileAlias>
          rowKey={(binding) => `${binding.agentId}:${binding.kind}:${binding.alias}`}
          dataSource={[...aliases]}
          loading={loading}
          pagination={false}
          locale={{ emptyText: <Empty description={t('aliases.empty')} /> }}
          columns={[
            {
              title: t('aliases.column.agent'),
              dataIndex: 'agentId',
              render: (value: string) => <Tag>{value}</Tag>,
            },
            {
              title: t('aliases.column.kind'),
              dataIndex: 'kind',
              render: (value: ProfileAliasKind) => (
                <Tag color={value === 'account' ? 'blue' : 'purple'}>
                  {value === 'account' ? t('aliases.kind.account') : t('aliases.kind.execution')}
                </Tag>
              ),
            },
            {
              title: t('aliases.column.alias'),
              dataIndex: 'alias',
              render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
            },
            {
              title: t('aliases.column.profile'),
              dataIndex: 'profileId',
              render: (_value: string, binding) => profileName(binding),
            },
            {
              title: '',
              key: 'actions',
              render: (_value, binding) => (
                <Popconfirm
                  title={t('aliases.unbind.confirm')}
                  onConfirm={() =>
                    void unbindAlias({
                      agentId: binding.agentId,
                      kind: binding.kind,
                      alias: binding.alias,
                    })
                  }
                >
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              ),
            },
          ]}
        />
        {adding && (
          <Space size={8} wrap className="alias-bindings-form">
            <Select
              placeholder={t('aliases.form.agent')}
              value={agentId}
              options={agentOptions}
              onChange={(value) => {
                setAgentId(value)
                setProfileId(undefined)
              }}
              className="alias-bindings-agent"
            />
            <Select<ProfileAliasKind>
              value={kind}
              options={[
                { value: 'account', label: t('aliases.kind.account') },
                { value: 'execution', label: t('aliases.kind.execution') },
              ]}
              onChange={(value) => {
                setKind(value)
                setProfileId(undefined)
              }}
            />
            <Input
              placeholder={t('aliases.form.alias')}
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              className="alias-bindings-alias"
            />
            <Select
              placeholder={t('aliases.form.profile')}
              value={profileId}
              options={profileOptions}
              onChange={setProfileId}
              disabled={agentId === undefined}
              className="alias-bindings-profile"
            />
            <Button
              type="primary"
              loading={saving}
              disabled={
                agentId === undefined || profileId === undefined || alias.trim().length === 0
              }
              onClick={() => void submit()}
            >
              {t('aliases.form.bind')}
            </Button>
            <Button onClick={() => setAdding(false)}>{t('aliases.form.cancel')}</Button>
          </Space>
        )}
      </Space>
    </Card>
  )
}
