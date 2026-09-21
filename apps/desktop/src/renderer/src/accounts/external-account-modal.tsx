import { Alert, Input, Modal, Radio, Select, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { AdapterAgentInfo, WslDistribution } from '@teskra/contracts'

import { useTranslation } from '../i18n'
import { useAgentStore } from '../stores/agent-store'
import { useAccountProfileStore } from './account-profile-store'
import {
  isValidConfigHomePath,
  adapterBackedAgentId,
  adapterBackedDefinitions,
} from './account-view-model'

interface ExternalAccountModalProps {
  readonly open: boolean
  readonly onClose: () => void
}

/**
 * §49/§50.2 — importing an existing CLI home is an explicit user action with
 * a hand-typed absolute path. The directory stays managed externally: Teskra
 * never deletes it and never touches its login state.
 */
export function ExternalAccountModal({ open, onClose }: ExternalAccountModalProps) {
  const { t } = useTranslation()
  const definitions = useAgentStore((state) => state.definitions)
  const createProfile = useAccountProfileStore((state) => state.createProfile)
  const storeError = useAccountProfileStore((state) => state.error)
  const clearError = useAccountProfileStore((state) => state.clearError)

  const [agentId, setAgentId] = useState<string>()
  const [adapterAgentIds, setAdapterAgentIds] = useState<readonly AdapterAgentInfo[]>()
  const [name, setName] = useState('')
  const [runtimeKind, setRuntimeKind] = useState<'windows' | 'wsl'>('windows')
  const [distro, setDistro] = useState<string>()
  const [distributions, setDistributions] = useState<readonly WslDistribution[]>([])
  const [configHome, setConfigHome] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!open) return
    setAgentId((current) => current ?? definitions[0]?.id)
    setAdapterAgentIds(undefined)
    clearError()
  }, [open])

  // §4.2: only adapter-backed agents can create a profile — filter the
  // "new account" entry to them (failure keeps the previous unfiltered list).
  useEffect(() => {
    if (!open) return
    let active = true
    void window.teskra.account.listAdapterAgents().then((result) => {
      if (active && result.ok) setAdapterAgentIds(result.data)
    })
    return () => {
      active = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    setAgentId((current) => adapterBackedAgentId(current, definitions, adapterAgentIds))
  }, [open, definitions, adapterAgentIds])

  const creatableDefinitions = adapterBackedDefinitions(definitions, adapterAgentIds)

  useEffect(() => {
    if (!open || runtimeKind !== 'wsl') return
    void window.teskra.runtime.listWslDistributions().then((result) => {
      if (result.ok) setDistributions(result.data)
    })
  }, [open, runtimeKind])

  const configHomeValid = isValidConfigHomePath(configHome.trim(), runtimeKind)
  const runtimeValid = runtimeKind === 'windows' || (distro ?? '').length > 0
  const valid = agentId !== undefined && name.trim().length > 0 && configHomeValid && runtimeValid

  const create = async (): Promise<void> => {
    if (agentId === undefined) return
    setCreating(true)
    const created = await createProfile({
      agentId,
      name: name.trim(),
      authType: 'external',
      runtime: runtimeKind === 'wsl' ? { kind: 'wsl', distro: distro ?? '' } : { kind: 'windows' },
      configHome: configHome.trim(),
    })
    setCreating(false)
    if (created !== undefined) onClose()
  }

  return (
    <Modal
      title={t('accounts.external.title')}
      open={open}
      onCancel={onClose}
      onOk={() => void create()}
      confirmLoading={creating}
      okButtonProps={{ disabled: !valid }}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} className="account-modal-form">
        <Alert type="info" showIcon message={t('accounts.external.body')} />
        {storeError !== undefined && <Alert type="error" showIcon message={storeError.message} />}
        <label className="account-field">
          <Typography.Text>{t('accounts.wizard.step.agent')}</Typography.Text>
          <Select
            value={agentId}
            onChange={setAgentId}
            options={creatableDefinitions.map((definition) => ({
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
          <Typography.Text>{t('accounts.wizard.step.runtime')}</Typography.Text>
          <Radio.Group
            value={runtimeKind}
            onChange={(event) => setRuntimeKind(event.target.value as 'windows' | 'wsl')}
            options={[
              { value: 'windows', label: t('accounts.wizard.runtime.windows') },
              { value: 'wsl', label: t('accounts.wizard.runtime.wsl') },
            ]}
            optionType="button"
            buttonStyle="solid"
          />
        </label>
        {runtimeKind === 'wsl' && (
          <label className="account-field">
            <Typography.Text>{t('accounts.wizard.runtime.distro')}</Typography.Text>
            <Select
              value={distro}
              onChange={setDistro}
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
        <label className="account-field">
          <Typography.Text>{t('accounts.external.configHome')}</Typography.Text>
          <Input
            value={configHome}
            placeholder={t('accounts.external.configHomePlaceholder')}
            {...(configHome.length === 0 || configHomeValid ? {} : { status: 'error' as const })}
            onChange={(event) => setConfigHome(event.target.value)}
          />
          {configHome.length > 0 && !configHomeValid && (
            <Typography.Text type="danger">
              {t('accounts.external.configHomeRequired')}
            </Typography.Text>
          )}
          <Typography.Text type="secondary">{t('accounts.managedExternally')}</Typography.Text>
        </label>
      </Space>
    </Modal>
  )
}
