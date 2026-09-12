/**
 * English (source) dictionary. Every user-facing UI string lives here under a
 * flat dotted key; the type of this map is the authoritative key set — zh-CN
 * must provide a value for every key (enforced by the type of zh-CN).
 */
export const enUS = {
  'app.tagline': 'Orchestrate your coding agents.',
  'app.language': 'Language',
  'app.language.en-US': 'English',
  'app.language.zh-CN': '中文',

  'nav.home': 'Home',
  'nav.workspace': 'Workspace',
  'nav.tasks': 'Tasks',
  'nav.runs': 'Runs',
  'nav.git': 'Git',
  'nav.terminal': 'Terminal',
  'nav.doctor': 'Doctor',
  'nav.recovery': 'Recovery',
  'nav.settings': 'Settings',

  'topbar.noWorkspace': 'No workspace',
  'topbar.noBranch': 'No branch',

  'workspaceRequired.body': 'Open a workspace before using {feature}.',
  'workspaceRequired.action': 'Choose workspace',

  'agent.attendedWarning': 'Direct writes to the main workspace — no isolation',
  'agent.attendedWarningDetail':
    'Attended runs use the current workspace. Review changes before committing.',
  'agent.noEnforcement':
    "This Agent's permissions cannot be enforced by Teskra — it relies on worktree isolation only",
  'agent.noEnforcementDetail':
    'This Agent exposes no permission mechanism Teskra can project to; its approval mode was not enforceable.',
  'agent.noEnforcementDetailInteractive':
    'This Agent exposes no permission mechanism Teskra can project to. Approval mode has no effect on it; only worktree isolation limits what it can change.',
  'agentPicker.suggestAlternative': 'Consider {name} instead',
} as const

export type TranslationKey = keyof typeof enUS
export type TranslationParams = Record<string, string | number>
