import { MoreOutlined, PlusOutlined } from '@ant-design/icons'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Drawer,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import { useEffect, useMemo, useState } from 'react'

import type { AgentAccountProfile, WslDistribution } from '@teskra/contracts'

import { useAccountProfileStore } from '../../accounts/account-profile-store'
import {
  accountLastUsedLabel,
  accountRuntimeLabel,
  accountStatusTag,
  defaultAccountProfileId,
  isValidAccountSlug,
  profilesByAgent,
  slugifyAccountName,
} from '../../accounts/account-view-model'
import { LoginTerminalView } from '../../accounts/login-terminal-view'
import { AppErrorAlert } from '../../components/app-error-alert'
import { useTranslation } from '../../i18n'
import { useAgentStore } from '../../stores/agent-store'
import { useSettingsStore } from '../settings-store'

/**
 * TASK-103 (Milestone 24 §22) — Settings → Agents → Accounts. Cards are
 * grouped per Agent; every lifecycle action goes through the account store so
 * the list stays fresh via the account.* event subscriptions.
 */
export function AccountsSettingsSection() {
  const { t } = useTranslation()
  const profiles = useAccountProfileStore((state) => state.profiles)
  const loading = useAccountProfileStore((state) => state.loading)
  const error = useAccountProfileStore((state) => state.error)
  const refresh = useAccountProfileStore((state) => state.refresh)
  const startSynchronization = useAccountProfileStore((state) => state.startSynchronization)
  const clearError = useAccountProfileStore((state) => state.clearError)
  const definitions = useAgentStore((state) => state.definitions)
  const loadDefinitions = useAgentStore((state) => state.loadDefinitions)
  const resolved = useSettingsStore((state) => state.resolved)
  const loadSettings = useSettingsStore((state) => state.load)

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<AgentAccountProfile>()
  const [removing, setRemoving] = useState<AgentAccountProfile>()
  const [loggingIn, setLoggingIn] = useState<AgentAccountProfile>()

  // §18.0: opening the page issues one account.list, which is also Main's
  // lazy limited-sweep trigger — no separate sweep call exists.
  useEffect(() => {
    void refresh()
    void loadDefinitions()
    if (useSettingsStore.getState().resolved === undefined) void loadSettings()
    return startSynchronization()
  }, [refresh, loadDefinitions, loadSettings, startSynchronization])

  const groups = useMemo(() => profilesByAgent(profiles), [profiles])
  // Agent order follows the registry definitions; profiles whose agent has no
  // definition (e.g. an uninstalled CLI) still render, appended at the end.
  const agentOrder = useMemo(() => {
    const known = definitions.map((definition) => definition.id)
    const unknown = [...groups.keys()].filter((agentId) => !known.includes(agentId))
    return [...known, ...unknown]
  }, [definitions, groups])

  return (
    <Space direction="vertical" size={18} className="settings-section-stack">
      <div>
        <Typography.Text className="settings-eyebrow">
          {t('settings.section.agents.title')}
        </Typography.Text>
        <Typography.Title level={3}>{t('settings.section.accounts.title')}</Typography.Title>
        <Typography.Paragraph type="secondary">{t('accounts.subtitle')}</Typography.Paragraph>
      </div>
      {error !== undefined && <AppErrorAlert error={error} onClose={clearError} />}
      {/* §51: first-run guidance — with no profiles the CLI default account is in use. */}
      {profiles.length === 0 && !loading && (
        <Alert type="info" showIcon message={t('accounts.empty.guidance')} />
      )}
      <Spin spinning={loading}>
        {definitions.length === 0 && profiles.length === 0 && !loading ? (
          <Empty description={t('settings.agents.empty')} />
        ) : (
          <Space direction="vertical" size={16} className="account-agent-list">
            {agentOrder.map((agentId) => {
              const definition = definitions.find((candidate) => candidate.id === agentId)
              const agentProfiles = groups.get(agentId) ?? []
              const defaultId = defaultAccountProfileId(resolved, agentId)
              return (
                <Card
                  key={agentId}
                  size="small"
                  title={definition?.name ?? agentId}
                  extra={<Tag>{agentId}</Tag>}
                >
                  <Space direction="vertical" size={12} className="account-card-list">
                    {agentProfiles.map((profile) => (
                      <AccountCard
                        key={profile.id}
                        profile={profile}
                        isDefault={profile.id === defaultId}
                        onEdit={() => setEditing(profile)}
                        onRemove={() => setRemoving(profile)}
                        onLogin={() => setLoggingIn(profile)}
                      />
                    ))}
                    <Button type="dashed" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
                      {t('accounts.add')}
                    </Button>
                  </Space>
                </Card>
              )
            })}
          </Space>
        )}
      </Spin>

      <AddAccountModal open={adding} onClose={() => setAdding(false)} />
      {editing !== undefined && (
        <EditProfileModal profile={editing} onClose={() => setEditing(undefined)} />
      )}
      {removing !== undefined && (
        <RemoveProfileModal
          profile={removing}
          isDefault={removing.id === defaultAccountProfileId(resolved, removing.agentId)}
          onClose={() => setRemoving(undefined)}
        />
      )}
      <Drawer
        title={loggingIn === undefined ? '' : t('accounts.login.title', { name: loggingIn.name })}
        width={720}
        open={loggingIn !== undefined}
        onClose={() => setLoggingIn(undefined)}
        destroyOnHidden
      >
        {loggingIn !== undefined && (
          <LoginTerminalView
            profileId={loggingIn.id}
            title={loggingIn.name}
            className="account-login-terminal"
          />
        )}
      </Drawer>
    </Space>
  )
}

interface AccountCardProps {
  readonly profile: AgentAccountProfile
  readonly isDefault: boolean
  readonly onEdit: () => void
  readonly onRemove: () => void
  readonly onLogin: () => void
}

function AccountCard({ profile, isDefault, onEdit, onRemove, onLogin }: AccountCardProps) {
  const { t } = useTranslation()
  const setDefaultProfile = useAccountProfileStore((state) => state.setDefaultProfile)
  const detectProfile = useAccountProfileStore((state) => state.detectProfile)
  const disableProfile = useAccountProfileStore((state) => state.disableProfile)
  const enableProfile = useAccountProfileStore((state) => state.enableProfile)
  const loadSettings = useSettingsStore((state) => state.load)
  const [busy, setBusy] = useState(false)
  const status = accountStatusTag(profile, t)

  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    await operation()
    setBusy(false)
  }

  const useAsDefault = async (): Promise<void> => {
    if (await setDefaultProfile(profile.agentId, profile.id)) await loadSettings()
  }

  return (
    <Card size="small" className="account-card">
      <Space direction="vertical" size={6} className="account-card-body">
        <Space size={8} wrap>
          <Typography.Text strong>{profile.name}</Typography.Text>
          <Tag color={status.color}>{status.label}</Tag>
          {isDefault && <Tag color="blue">{t('accounts.default.tag')}</Tag>}
          {profile.authType === 'external' && <Tag>{t('accounts.managedExternally')}</Tag>}
        </Space>
        <Typography.Text type="secondary">
          {t('accounts.runtime')}: {accountRuntimeLabel(profile.runtime)}
        </Typography.Text>
        <Typography.Text type="secondary">
          {t('accounts.lastUsed', { time: accountLastUsedLabel(profile, Date.now(), t) })}
        </Typography.Text>
        {profile.configHome !== undefined && (
          <Typography.Text type="secondary" ellipsis>
            {t('accounts.configHome')}: <Typography.Text code>{profile.configHome}</Typography.Text>
          </Typography.Text>
        )}
        <Space size={8} wrap>
          {!isDefault && profile.enabled && (
            <Button size="small" loading={busy} onClick={() => void run(useAsDefault)}>
              {t('accounts.useAsDefault')}
            </Button>
          )}
          <Button size="small" onClick={onLogin}>
            {t('accounts.open')}
          </Button>
          <Dropdown
            menu={{
              items: [
                { key: 'edit', label: t('accounts.edit') },
                { key: 'detect', label: t('accounts.detect') },
                profile.enabled
                  ? { key: 'disable', label: t('accounts.disable') }
                  : { key: 'enable', label: t('accounts.enable') },
                { type: 'divider' },
                { key: 'remove', label: t('accounts.remove'), danger: true },
              ],
              onClick: ({ key }) => {
                if (key === 'edit') onEdit()
                else if (key === 'detect') void run(() => detectProfile(profile.id))
                else if (key === 'disable')
                  void run(async () => {
                    await disableProfile(profile.id)
                    await loadSettings()
                  })
                else if (key === 'enable') void run(() => enableProfile(profile.id))
                else if (key === 'remove') onRemove()
              },
            }}
          >
            <Button size="small" type="text" icon={<MoreOutlined />} loading={busy} />
          </Dropdown>
        </Space>
      </Space>
    </Card>
  )
}

interface EditProfileModalProps {
  readonly profile: AgentAccountProfile
  readonly onClose: () => void
}

function EditProfileModal({ profile, onClose }: EditProfileModalProps) {
  const { t } = useTranslation()
  const updateProfile = useAccountProfileStore((state) => state.updateProfile)
  const [name, setName] = useState(profile.name)
  const [description, setDescription] = useState(profile.description ?? '')
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState<number | null>(
    profile.maxConcurrentRuns ?? null,
  )
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    const updated = await updateProfile({
      id: profile.id,
      patch: {
        ...(name.trim() === profile.name ? {} : { name: name.trim() }),
        description: description.trim().length === 0 ? null : description.trim(),
        maxConcurrentRuns,
      },
    })
    setSaving(false)
    if (updated !== undefined) onClose()
  }

  return (
    <Modal
      title={t('accounts.edit.title')}
      open
      onCancel={onClose}
      onOk={() => void save()}
      confirmLoading={saving}
      okButtonProps={{ disabled: name.trim().length === 0 }}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} className="account-modal-form">
        <label className="account-field">
          <Typography.Text>{t('accounts.edit.name')}</Typography.Text>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="account-field">
          <Typography.Text>{t('accounts.edit.description')}</Typography.Text>
          <Input value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="account-field">
          <Typography.Text>{t('accounts.edit.maxConcurrentRuns')}</Typography.Text>
          <InputNumber
            min={1}
            value={maxConcurrentRuns}
            onChange={(value) => setMaxConcurrentRuns(value)}
          />
        </label>
      </Space>
    </Modal>
  )
}

interface RemoveProfileModalProps {
  readonly profile: AgentAccountProfile
  readonly isDefault: boolean
  readonly onClose: () => void
}

/** §47.1/§47.2 — remove is a soft disable; deleting the CLI home is opt-in. */
function RemoveProfileModal({ profile, isDefault, onClose }: RemoveProfileModalProps) {
  const { t } = useTranslation()
  const removeProfile = useAccountProfileStore((state) => state.removeProfile)
  const loadSettings = useSettingsStore((state) => state.load)
  const [deleteHome, setDeleteHome] = useState(false)
  const [removing, setRemoving] = useState(false)
  const external = profile.authType === 'external'

  const confirm = async (): Promise<void> => {
    setRemoving(true)
    const removed = await removeProfile(profile.id, deleteHome && !external ? true : undefined)
    if (removed !== undefined) await loadSettings()
    setRemoving(false)
    if (removed !== undefined) onClose()
  }

  return (
    <Modal
      title={t('accounts.remove.title')}
      open
      onCancel={onClose}
      onOk={() => void confirm()}
      confirmLoading={removing}
      okButtonProps={{ danger: true }}
      destroyOnHidden
    >
      <Space direction="vertical" size={12}>
        <Typography.Paragraph>{t('accounts.remove.body')}</Typography.Paragraph>
        {/* §47.2(1): disabling the default profile also clears the default. */}
        {isDefault && (
          <Alert type="warning" showIcon message={t('accounts.remove.defaultWarning')} />
        )}
        {external ? (
          <Typography.Text type="secondary">
            {t('accounts.remove.deleteHomeExternal')}
          </Typography.Text>
        ) : (
          <Checkbox checked={deleteHome} onChange={(event) => setDeleteHome(event.target.checked)}>
            {t('accounts.remove.deleteHome')}
          </Checkbox>
        )}
      </Space>
    </Modal>
  )
}

interface AddAccountModalProps {
  readonly open: boolean
  readonly onClose: () => void
}

/**
 * Minimal creation entry (agent / name / slug / runtime). TASK-104 replaces
 * this with the six-step wizard (§23) including the login terminal.
 */
function AddAccountModal({ open, onClose }: AddAccountModalProps) {
  const { t } = useTranslation()
  const definitions = useAgentStore((state) => state.definitions)
  const createProfile = useAccountProfileStore((state) => state.createProfile)
  const error = useAccountProfileStore((state) => state.error)
  const [agentId, setAgentId] = useState<string>()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [runtimeKind, setRuntimeKind] = useState<'windows' | 'wsl'>('windows')
  const [distro, setDistro] = useState<string>()
  const [distributions, setDistributions] = useState<readonly WslDistribution[]>([])
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!open || runtimeKind !== 'wsl') return
    void window.teskra.runtime.listWslDistributions().then((result) => {
      if (result.ok) setDistributions(result.data)
    })
  }, [open, runtimeKind])

  useEffect(() => {
    if (open) {
      setAgentId((current) => current ?? definitions[0]?.id)
    }
  }, [open, definitions])

  const effectiveSlug = slugTouched ? slug : slugifyAccountName(name)
  const slugValid = isValidAccountSlug(effectiveSlug)
  const runtimeValid = runtimeKind === 'windows' || (distro ?? '').length > 0
  const valid = agentId !== undefined && name.trim().length > 0 && slugValid && runtimeValid

  const create = async (): Promise<void> => {
    if (agentId === undefined) return
    setCreating(true)
    const created = await createProfile({
      agentId,
      name: name.trim(),
      authType: 'subscription',
      runtime: runtimeKind === 'wsl' ? { kind: 'wsl', distro: distro ?? '' } : { kind: 'windows' },
      slug: effectiveSlug,
    })
    setCreating(false)
    if (created !== undefined) onClose()
  }

  return (
    <Modal
      title={t('accounts.wizard.title')}
      open={open}
      onCancel={onClose}
      onOk={() => void create()}
      confirmLoading={creating}
      okButtonProps={{ disabled: !valid }}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} className="account-modal-form">
        {error !== undefined && <Alert type="error" showIcon message={error.message} />}
        <label className="account-field">
          <Typography.Text>{t('accounts.wizard.step.agent')}</Typography.Text>
          <Select
            value={agentId}
            onChange={setAgentId}
            options={definitions.map((definition) => ({
              value: definition.id,
              label: definition.name,
            }))}
          />
        </label>
        <label className="account-field">
          <Typography.Text>{t('accounts.wizard.name.label')}</Typography.Text>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="account-field">
          <Typography.Text>{t('accounts.wizard.slug.label')}</Typography.Text>
          <Input
            value={effectiveSlug}
            {...(slugValid ? {} : { status: 'error' as const })}
            onChange={(event) => {
              setSlugTouched(true)
              setSlug(event.target.value)
            }}
          />
          {!slugValid && (
            <Typography.Text type="danger">{t('accounts.wizard.slug.invalid')}</Typography.Text>
          )}
        </label>
        <label className="account-field">
          <Typography.Text>{t('accounts.wizard.step.runtime')}</Typography.Text>
          <Radio.Group
            value={runtimeKind}
            onChange={(event) => setRuntimeKind(event.target.value as 'windows' | 'wsl')}
            options={[
              { value: 'windows', label: t('accounts.wizard.runtime.windows') },
              { value: 'wsl', label: t('accounts.wizard.runtime.wsl') },
            ]}
          />
        </label>
        {runtimeKind === 'wsl' && (
          <label className="account-field">
            <Typography.Text>{t('accounts.wizard.runtime.distro')}</Typography.Text>
            <Select
              value={distro}
              onChange={setDistro}
              {...(runtimeValid ? {} : { status: 'error' as const })}
              options={distributions.map((distribution) => ({
                value: distribution.name,
                label: distribution.name,
              }))}
            />
            {!runtimeValid && (
              <Typography.Text type="danger">
                {t('accounts.wizard.runtime.distroRequired')}
              </Typography.Text>
            )}
          </label>
        )}
      </Space>
    </Modal>
  )
}
