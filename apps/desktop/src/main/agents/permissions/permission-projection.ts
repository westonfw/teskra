import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  AgentDefinition,
  AgentPermissionConfig,
  ApprovalMode,
  IpcResult,
  TeskraPermissionProfile,
} from '@teskra/contracts'

import { type InternalAppError, toPublicError } from '../../errors'

/**
 * ADR-0002 / TASK-077 — Policy Projection.
 *
 * Teskra cannot intercept Agent commands before execution (it is a PTY host,
 * not a syscall gateway), so the unified TeskraPermissionProfile is translated
 * into each Agent CLI's own mechanism *before* the Run starts:
 *
 *   Claude Code → settings.json `permissions` + `--permission-mode` / `--settings`
 *   Codex       → `--sandbox` + `--ask-for-approval` launch arguments
 *   Fake Agent  → none (only environment/worktree isolation applies)
 *
 * The mapping functions live here on the Main side — contracts carries only
 * the data types, because contracts ships inside the sandboxed preload bundle.
 */

export interface AgentPermissionMapping {
  /**
   * CLI-side policy document to write before launch, if the CLI supports one.
   * `grantDir` is the Run directory holding the handoff/artifact files the
   * Agent MUST be able to write (ADR-0004) even under otherwise-restrictive
   * modes; mappings that support path-scoped rules should grant exactly it.
   */
  buildConfig?(
    profile: TeskraPermissionProfile,
    grantDir?: string,
  ): AgentPermissionConfig | undefined
  /** CLI launch arguments projecting the profile; `configPath` links buildConfig output. */
  buildArgs?(profile: TeskraPermissionProfile, configPath?: string): string[]
}

/**
 * Claude Code `--permission-mode` values. Note the CLI accepts exactly
 * plan / default / acceptEdits / bypassPermissions — projecting anything else
 * would be an invalid configuration (ADR-0002: never pretend to enforce).
 *
 * 'read-only' maps to 'default', NOT 'plan': plan mode blocks EVERY
 * non-read-only tool call — including writing the handoff file the Run
 * contract (ADR-0004) requires — and allow rules do not lift it (verified
 * empirically against Claude Code 2.1.x, 2026-09-13). In an unattended
 * session 'default' denies every action without a matching allow rule, so
 * the read-only boundary holds; the settings document's Edit(<runDir>/**)
 * grant lets exactly the handoff through. Trade-off, documented for honesty:
 * unattended reviewers also cannot run Bash (no human to approve it), which
 * plan mode would have permitted for read-only commands — file reads remain
 * unrestricted either way.
 */
const CLAUDE_PERMISSION_MODES: Record<ApprovalMode, string> = {
  'read-only': 'default',
  manual: 'default',
  'safe-auto': 'acceptEdits',
  'full-auto': 'bypassPermissions',
}

/**
 * Claude Code path-scoped allow rule for the Run directory. Edit(path) rules
 * cover every file-editing tool (the CLI itself rejects Write(path) rules and
 * points at Edit). Forward slashes keep the rule valid on Windows and WSL.
 * NOTE: the path written here is the HOST-side run directory — on a
 * WSL-on-Windows runtime the agent sees `/mnt/c/...`, so the grant only
 * matches host-native runtimes; WSL reviewers fall back to the terminal-log
 * handoff degradation until the projection learns runtime-scoped paths.
 */
function claudeEditGrant(grantDir: string): string {
  return `Edit(${grantDir.replaceAll('\\', '/')}/**)`
}

export const CLAUDE_PERMISSION_MAPPING: AgentPermissionMapping = {
  buildConfig(profile, grantDir) {
    const grants = grantDir === undefined ? [] : [claudeEditGrant(grantDir)]
    return {
      kind: 'claude-code-settings',
      document: {
        permissions: {
          defaultMode: CLAUDE_PERMISSION_MODES[profile.approvalMode],
          ...(profile.allow.length > 0 || grants.length > 0
            ? { allow: [...grants, ...profile.allow] }
            : {}),
          ...(profile.deny.length > 0 ? { deny: profile.deny } : {}),
        },
      },
    }
  },
  buildArgs(profile, configPath) {
    return [
      '--permission-mode',
      CLAUDE_PERMISSION_MODES[profile.approvalMode],
      ...(configPath === undefined ? [] : ['--settings', configPath]),
    ]
  },
}

/**
 * Codex CLI projects the profile to approval/sandbox flags only — it has no
 * rule-list mechanism we can target, so allow/deny entries are deliberately
 * NOT translated (generating them would claim an enforcement that does not
 * exist).
 */
export const CODEX_PERMISSION_MAPPING: AgentPermissionMapping = {
  buildArgs(profile) {
    switch (profile.approvalMode) {
      case 'read-only':
        return ['--sandbox', 'read-only', '--ask-for-approval', 'on-request']
      case 'manual':
      case 'safe-auto':
        return ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']
      case 'full-auto':
        return ['--sandbox', 'workspace-write', '--ask-for-approval', 'never']
    }
  },
}

/**
 * Kimi Code CLI permission modes are launch flags: `--plan` (read-only
 * planning), `--yolo` (Ask When Needed), `--auto` (Never Ask); the Always-Ask
 * default needs no flag. It has no rule-list mechanism we can target, so
 * allow/deny entries are deliberately NOT translated. The flags conflict with
 * `--prompt`; the Adapter omits them for headless launches.
 */
const KIMI_PERMISSION_ARGS: Record<ApprovalMode, readonly string[]> = {
  'read-only': ['--plan'],
  manual: [],
  'safe-auto': ['--yolo'],
  'full-auto': ['--auto'],
}

export const KIMI_PERMISSION_MAPPING: AgentPermissionMapping = {
  buildArgs(profile) {
    return [...KIMI_PERMISSION_ARGS[profile.approvalMode]]
  },
}

/** Built-in projections, keyed by AgentDefinition.id. Agents without an entry have no projection. */
export const AGENT_PERMISSION_MAPPINGS: ReadonlyMap<string, AgentPermissionMapping> = new Map([
  ['claude', CLAUDE_PERMISSION_MAPPING],
  ['codex', CODEX_PERMISSION_MAPPING],
  ['kimi', KIMI_PERMISSION_MAPPING],
])

export function permissionProfileForApprovalMode(
  agentId: string,
  approvalMode: ApprovalMode,
): TeskraPermissionProfile {
  return { id: `${agentId}:${approvalMode}`, approvalMode, allow: [], deny: [] }
}

export interface PreparedAgentPermission {
  readonly profile: TeskraPermissionProfile
  readonly configPath?: string
}

function permissionWriteFailed(path: string, cause: unknown): InternalAppError {
  return {
    code: 'UNKNOWN',
    message: 'Failed to write the Agent permission configuration.',
    retryable: true,
    detail: `write failed for ${path}`,
    cause,
  }
}

/**
 * Projects the profile for one Run: writes the CLI-side policy file into the
 * Run directory when the mapping produces one and reports the path the
 * Adapter must reference. Returns `undefined` for `permissionEnforcement:
 * "none"` agents and for agents without a mapping — no config is generated
 * for them, so nothing claims to constrain what cannot be constrained.
 */
export function prepareAgentPermission(options: {
  definition: AgentDefinition
  profile: TeskraPermissionProfile
  runDir: string
}): IpcResult<PreparedAgentPermission | undefined> {
  const { definition, profile, runDir } = options
  if (definition.permissionEnforcement === 'none') return { ok: true, data: undefined }
  const mapping = AGENT_PERMISSION_MAPPINGS.get(definition.id)
  if (mapping === undefined) return { ok: true, data: undefined }

  const config = mapping.buildConfig?.(profile, runDir)
  if (config === undefined) return { ok: true, data: { profile } }

  const configPath = join(runDir, 'permission-settings.json')
  try {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${JSON.stringify(config.document, null, 2)}\n`, 'utf8')
  } catch (cause) {
    return { ok: false, error: toPublicError(permissionWriteFailed(configPath, cause)) }
  }
  // The returned path is host-side (runDir is); the CliAgentAdapter translates
  // it into the runtime's path form before putting it on the CLI command line.
  return { ok: true, data: { profile, configPath } }
}
