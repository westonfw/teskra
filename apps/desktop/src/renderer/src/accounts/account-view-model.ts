import type {
  AccountProfileStatus,
  AgentAccountProfile,
  ResolvedConfig,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'

import type { TranslationKey } from '../i18n'

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

export interface AccountStatusTag {
  readonly color: string
  readonly label: string
}

const STATUS_COLORS: Record<AccountProfileStatus, string> = {
  ready: 'green',
  limited: 'orange',
  'login-required': 'gold',
  expired: 'red',
  unknown: 'default',
}

const STATUS_KEYS: Record<AccountProfileStatus, TranslationKey> = {
  ready: 'accounts.status.ready',
  limited: 'accounts.status.limited',
  'login-required': 'accounts.status.loginRequired',
  expired: 'accounts.status.expired',
  unknown: 'accounts.status.unknown',
}

/**
 * §16 — `disabled` is a presentation state derived from `enabled`, never a
 * stored status. A limited profile additionally shows its reset time.
 */
export function accountStatusTag(profile: AgentAccountProfile, t: Translate): AccountStatusTag {
  if (!profile.enabled) {
    return { color: 'default', label: t('accounts.status.disabled') }
  }
  if (profile.status === 'limited' && profile.limitedUntil !== undefined) {
    return {
      color: STATUS_COLORS.limited,
      label: t('accounts.status.limitedUntil', {
        time: new Date(profile.limitedUntil).toLocaleString(),
      }),
    }
  }
  return { color: STATUS_COLORS[profile.status], label: t(STATUS_KEYS[profile.status]) }
}

export function accountRuntimeLabel(runtime: WorkspaceRuntimeRef): string {
  return runtime.kind === 'wsl' ? `WSL · ${runtime.distro ?? ''}` : 'Windows'
}

/**
 * Compact relative "last used" text. Returns undefined when the profile was
 * never used so the card can show a "never" placeholder instead.
 */
export function accountLastUsedLabel(
  profile: AgentAccountProfile,
  now: number,
  t: Translate,
): string {
  if (profile.lastUsedAt === undefined) return t('accounts.lastUsed.never')
  const seconds = Math.max(0, Math.floor((now - Date.parse(profile.lastUsedAt)) / 1_000))
  if (seconds < 60) return t('accounts.lastUsed.justNow')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('accounts.lastUsed.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('accounts.lastUsed.hours', { count: hours })
  return t('accounts.lastUsed.days', { count: Math.floor(hours / 24) })
}

/** §15: the per-agent default profile id from the resolved config (global layer). */
export function defaultAccountProfileId(
  resolved: ResolvedConfig | undefined,
  agentId: string,
): string | undefined {
  const value = resolved?.config.agents.defaultAccountProfiles[agentId]
  return value === null ? undefined : value
}

/** §48.1 — the only user-controlled path segment of a managed configHome. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/i

export function isValidAccountSlug(value: string): boolean {
  return SLUG_PATTERN.test(value)
}

/** Derives a slug suggestion from a display name; always lowercase per §48.1. */
export function slugifyAccountName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 32)
    .replace(/-+$/, '')
}

/** Groups profiles by agentId, preserving definition order then createdAt. */
export function profilesByAgent(
  profiles: readonly AgentAccountProfile[],
): ReadonlyMap<string, AgentAccountProfile[]> {
  const groups = new Map<string, AgentAccountProfile[]>()
  for (const profile of profiles) {
    const group = groups.get(profile.agentId) ?? []
    group.push(profile)
    groups.set(profile.agentId, group)
  }
  return groups
}
