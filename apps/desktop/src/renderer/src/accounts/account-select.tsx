import { Select, Typography } from 'antd'

import { useTranslation } from '../i18n'
import { useSettingsStore } from '../settings/settings-store'
import { useAccountProfileStore } from './account-profile-store'
import { defaultAccountProfileId } from './account-view-model'

const AUTO_VALUE = '__auto__'

interface AccountSelectProps {
  readonly agentId?: string | undefined
  /** Selected profile id; undefined = auto (default account / legacy CLI home). */
  readonly value?: string | undefined
  readonly onChange: (profileId: string | undefined) => void
  readonly disabled?: boolean | undefined
}

/**
 * Milestone 24 §25 — the Account dropdown of the Agent Start UI. Only
 * enabled profiles of the selected Agent are offered; "auto" leaves account
 * resolution to Main (per-agent default → legacy CLI home, §52). With at
 * most one candidate the selector collapses entirely so the form stays
 * simple (§25).
 */
export function AccountSelect({ agentId, value, onChange, disabled }: AccountSelectProps) {
  const { t } = useTranslation()
  const profiles = useAccountProfileStore((state) => state.profiles)
  const resolved = useSettingsStore((state) => state.resolved)

  const candidates =
    agentId === undefined
      ? []
      : profiles.filter((profile) => profile.agentId === agentId && profile.enabled)
  if (agentId === undefined || candidates.length <= 1) return null

  const defaultId = defaultAccountProfileId(resolved, agentId)

  return (
    <label className="account-select">
      <Typography.Text type="secondary">{t('accounts.select.label')}</Typography.Text>
      <Select
        value={value ?? AUTO_VALUE}
        onChange={(selected) => onChange(selected === AUTO_VALUE ? undefined : selected)}
        {...(disabled === undefined ? {} : { disabled })}
        options={[
          { value: AUTO_VALUE, label: t('accounts.select.auto') },
          ...candidates.map((profile) => ({
            value: profile.id,
            label:
              profile.id === defaultId
                ? `${profile.name} · ${t('accounts.default.tag')}`
                : profile.name,
          })),
        ]}
      />
    </label>
  )
}
