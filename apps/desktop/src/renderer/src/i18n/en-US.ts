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

  'home.eyebrow': 'HOME',
  'home.title': 'Dashboard',
  'home.subtitle': '{name} at a glance — active work, anything waiting on you, and agent health.',
  'home.refresh': 'Refresh',
  'home.noWorkspace.body': 'Open a workspace to see its dashboard.',
  'home.section.activeTasks': 'Active Tasks',
  'home.section.waitingForYou': 'Waiting For You',
  'home.section.interruptedRuns': 'Interrupted Runs',
  'home.section.mergeReady': 'Merge Ready',
  'home.section.agentAvailability': 'Agent Availability',
  'home.section.recentFailures': 'Recent Failures',
  'home.section.refresh': 'Refresh {title}',
  'home.section.open': 'Open {title}',
  'home.empty.activeTasks': 'No tasks running right now.',
  'home.empty.waitingForYou': 'Nothing is waiting on you.',
  'home.empty.interruptedRuns': 'No interrupted runs.',
  'home.empty.mergeReady': 'No worktrees ready to merge.',
  'home.empty.agentAvailability': 'No agents registered.',
  'home.empty.recentFailures': 'No recent failures.',
  'home.workflow': 'Workflow',
  'home.run.interrupted': 'interrupted',
  'home.run.failed': 'failed',
  'home.availability.rateLimited': 'rate limited',
  'home.availability.available': 'available',
  'home.availability.unavailable': 'unavailable',
  'home.availability.notInstalled': 'not installed',

  'workspace.eyebrow': 'WORKSPACES',
  'workspace.title': 'Choose where Agents work',
  'workspace.subtitle': 'Windows and WSL projects stay isolated by an explicit runtime boundary.',
  'workspace.openFolder': 'Open folder',
  'workspace.empty.title': 'No workspace is open',
  'workspace.empty.body': 'Open a Windows folder or connect a path inside WSL to begin.',
  'workspace.empty.action': 'Open your first workspace',
  'workspace.recent': 'Recent workspaces',
  'workspace.openTerminal': 'Open terminal',
  'workspace.switch': 'Switch',
  'workspace.removeConfirm.title': 'Remove this workspace from Teskra?',
  'workspace.removeConfirm.body': 'The project files will not be deleted.',
  'workspace.remove': 'Remove workspace',

  'workspace.dialog.title': 'Open workspace',
  'workspace.dialog.environment': 'Environment',
  'workspace.dialog.windows': 'Windows',
  'workspace.dialog.wsl': 'WSL',
  'workspace.dialog.wslDetectFailed': 'WSL distributions could not be detected',
  'workspace.dialog.distro': 'WSL distribution',
  'workspace.dialog.distroRequired': 'Choose a WSL distribution.',
  'workspace.dialog.distroPlaceholder': 'Select a distribution',
  'workspace.dialog.windowsFolder': 'Windows folder',
  'workspace.dialog.linuxPath': 'Linux path',
  'workspace.dialog.pathRequired': 'Enter a workspace path.',
  'workspace.dialog.wslPathHint':
    'Use a path inside the selected distribution, for example /home/me/project.',
  'workspace.dialog.browse': 'Browse',
  'workspace.dialog.displayName': 'Display name',
  'workspace.dialog.displayNameHint': 'Optional; defaults to the folder name.',
  'workspace.dialog.displayNamePlaceholder': 'My project',

  'wsl.unreachable': 'Teskra could not reach the runtime service.',

  'errorSuggestion.WORKSPACE_NOT_FOUND':
    'Check that the folder still exists and that its runtime is available.',
  'errorSuggestion.WSL_NOT_AVAILABLE': 'Install or start WSL, then retry the operation.',
  'errorSuggestion.WSL_DISTRO_NOT_FOUND':
    'Choose an installed distribution in Settings → Environment.',
  'errorSuggestion.AGENT_NOT_INSTALLED':
    'Install the Agent CLI or configure its executable in Settings.',
  'errorSuggestion.CAPABILITY_NOT_AVAILABLE':
    'This capability is not available in the current runtime.',
  'errorSuggestion.COMMAND_TIMEOUT':
    'Retry, or inspect the logs if the command continues to time out.',
  'errorSuggestion.PROCESS_NOT_FOUND':
    'The process has already exited. Refresh the active session.',
  'errorSuggestion.TERMINAL_NOT_FOUND': 'The terminal has already closed. Open a new terminal.',
  'errorSuggestion.MERGE_BLOCKED': 'Resolve the reported Git conflicts before retrying.',
  'errorSuggestion.VALIDATION_FAILED': 'Review the entered values and try again.',
  'errorSuggestion.UNKNOWN':
    'Retry the operation. If it persists, open the logs from Settings → Advanced.',
} as const

export type TranslationKey = keyof typeof enUS
export type TranslationParams = Record<string, string | number>
