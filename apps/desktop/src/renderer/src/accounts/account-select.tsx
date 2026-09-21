import { Select, Typography } from 'antd'

import type { AgentAccountProfile } from '@teskra/contracts'

import { useTranslation, type Translation } from '../i18n'
import { useSettingsStore } from '../settings/settings-store'
import { useAccountProfileStore } from './account-profile-store'
import { defaultAccountProfileId } from './account-view-model'

const AUTO_VALUE = '__auto__'

/**
 * §25 — the selector may collapse only when the sole candidate already is the
 * per-agent default (there is nothing to choose). A single non-default profile
 * must stay selectable, otherwise the run silently uses the host CLI home
 * (§37.1).
 */
export function accountSelectCollapses(
  candidates: readonly AgentAccountProfile[],
  defaultId: string | undefined,
): boolean {
  return candidates.length === 1 && candidates[0]?.id === defaultId
}

/**
 * §25/§50.1 — "auto" resolves to the per-agent default when one exists; with
 * no default it means no CODEX_HOME / CLAUDE_CONFIG_DIR projection at all,
 * which must be visible in the label.
 */
export function accountAutoLabel(
  defaultId: string | undefined,
  defaultProfile: AgentAccountProfile | undefined,
  t: Translation['t'],
): string {
  if (defaultId === undefined) return t('accounts.select.autoHost')
  if (defaultProfile === undefined) return t('accounts.select.auto')
  return t('accounts.select.autoDefault', { name: defaultProfile.name })
}

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
 * resolution to Main (per-agent default → legacy CLI home, §52). The selector
 * collapses only when the sole candidate is already the default
 * (`accountSelectCollapses`, §25).
 */
export function AccountSelect({ agentId, value, onChange, disabled }: AccountSelectProps) {
  const { t } = useTranslation()
  const profiles = useAccountProfileStore((state) => state.profiles)
  const resolved = useSettingsStore((state) => state.resolved)

  const candidates =
    agentId === undefined
      ? []
      : profiles.filter((profile) => profile.agentId === agentId && profile.enabled)
  if (agentId === undefined || candidates.length === 0) return null

  const defaultId = defaultAccountProfileId(resolved, agentId)
  if (accountSelectCollapses(candidates, defaultId)) return null

  const defaultProfile =
    defaultId === undefined ? undefined : profiles.find((profile) => profile.id === defaultId)

  return (
    <label className="account-select">
      <Typography.Text type="secondary">{t('accounts.select.label')}</Typography.Text>
      <Select
        value={value ?? AUTO_VALUE}
        onChange={(selected) => onChange(selected === AUTO_VALUE ? undefined : selected)}
        {...(disabled === undefined ? {} : { disabled })}
        options={[
          { value: AUTO_VALUE, label: accountAutoLabel(defaultId, defaultProfile, t) },
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
