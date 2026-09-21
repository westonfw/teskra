import type {
  AccountProfileStatus,
  AccountRateLimitStats,
  AdapterAgentInfo,
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

/** Compact relative timestamp shared by "last used" and the rate-limit stats. */
export function relativeTimeLabel(iso: string, now: number, t: Translate): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1_000))
  if (seconds < 60) return t('accounts.lastUsed.justNow')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('accounts.lastUsed.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('accounts.lastUsed.hours', { count: hours })
  return t('accounts.lastUsed.days', { count: Math.floor(hours / 24) })
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
  return relativeTimeLabel(profile.lastUsedAt, now, t)
}

/**
 * Rate-limit history line for the account card (Teskra's own ADR-0010
 * classifications, trailing 7 days). Returns undefined when the profile had
 * no rate-limited run in the window, so the card stays quiet — this is
 * history, never a live quota reading.
 */
export function accountRateLimitStatsLabel(
  stats: AccountRateLimitStats | undefined,
  now: number,
  t: Translate,
): string | undefined {
  if (stats === undefined || stats.rateLimitedCount === 0) return undefined
  return t('accounts.rateLimitStats', {
    count: stats.rateLimitedCount,
    time:
      stats.lastRateLimitedAt === undefined
        ? t('accounts.lastUsed.never')
        : relativeTimeLabel(stats.lastRateLimitedAt, now, t),
  })
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

/**
 * §5.3 — UX-level mirror of the contracts configHome rule for the external
 * profile form; Main re-validates authoritatively on create. When the target
 * runtime kind is known, the path shape must match it (P2-2): a Windows
 * profile never accepts a POSIX path and vice versa.
 */
export function isValidConfigHomePath(
  value: string,
  runtimeKind?: WorkspaceRuntimeRef['kind'],
): boolean {
  if (value.length === 0) return false
  if (value.startsWith('~') || value.includes('$') || value.includes('%')) return false
  const posixAbsolute = value.startsWith('/')
  const windowsAbsolute = value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value)
  if (runtimeKind === 'windows') return windowsAbsolute
  if (runtimeKind === 'wsl') return posixAbsolute
  return posixAbsolute || windowsAbsolute
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

/**
 * §49 — an external profile's login state is managed outside Teskra, so the
 * login terminal (which would rewrite its auth files) is not offered for it.
 * Main rejects the login channel too; this mirrors that decision in the UI.
 */
export function accountLoginAvailable(profile: AgentAccountProfile): boolean {
  return profile.authType !== 'external'
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

/**
 * §4.2 — the "new account" entry points (creation wizard, external import)
 * may only offer agents with a registered account profile adapter; creating
 * a profile for an adapter-less agent fails Main-side with "no account
 * profile adapter". `undefined` adapterAgents means the list has not loaded
 * (or the query failed): fall back to the unfiltered definitions rather than
 * blocking account creation. Only creation is filtered — existing profiles of
 * an agent whose adapter was removed must stay visible everywhere else.
 */
export function adapterBackedDefinitions<T extends { readonly id: string }>(
  definitions: readonly T[],
  adapterAgents: readonly AdapterAgentInfo[] | undefined,
): readonly T[] {
  if (adapterAgents === undefined) return definitions
  const backed = new Set(adapterAgents.map((agent) => agent.agentId))
  return definitions.filter((definition) => backed.has(definition.id))
}

/**
 * Selection companion of adapterBackedDefinitions: keeps the current agentId
 * when it is adapter-backed (or the adapter list is unknown), otherwise falls
 * back to the first adapter-backed definition.
 */
export function adapterBackedAgentId<T extends { readonly id: string }>(
  current: string | undefined,
  definitions: readonly T[],
  adapterAgents: readonly AdapterAgentInfo[] | undefined,
): string | undefined {
  if (adapterAgents === undefined) return current
  if (current !== undefined && adapterAgents.some((agent) => agent.agentId === current)) {
    return current
  }
  return adapterBackedDefinitions(definitions, adapterAgents)[0]?.id
}

/** The vendor usage page registered for an agent, if its adapter declares one. */
export function adapterUsageUrl(
  adapterAgents: readonly AdapterAgentInfo[] | undefined,
  agentId: string,
): string | undefined {
  return adapterAgents?.find((agent) => agent.agentId === agentId)?.usageUrl
}
