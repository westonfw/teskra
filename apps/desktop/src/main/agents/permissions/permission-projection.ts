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
  /** CLI-side policy document to write before launch, if the CLI supports one. */
  buildConfig?(profile: TeskraPermissionProfile): AgentPermissionConfig | undefined
  /** CLI launch arguments projecting the profile; `configPath` links buildConfig output. */
  buildArgs?(profile: TeskraPermissionProfile, configPath?: string): string[]
}

/**
 * Claude Code `--permission-mode` values. Note the CLI accepts exactly
 * plan / default / acceptEdits / bypassPermissions — projecting anything else
 * would be an invalid configuration (ADR-0002: never pretend to enforce).
 */
const CLAUDE_PERMISSION_MODES: Record<ApprovalMode, string> = {
  'read-only': 'plan',
  manual: 'default',
  'safe-auto': 'acceptEdits',
  'full-auto': 'bypassPermissions',
}

export const CLAUDE_PERMISSION_MAPPING: AgentPermissionMapping = {
  buildConfig(profile) {
    return {
      kind: 'claude-code-settings',
      document: {
        permissions: {
          defaultMode: CLAUDE_PERMISSION_MODES[profile.approvalMode],
          ...(profile.allow.length > 0 ? { allow: profile.allow } : {}),
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

/** Built-in projections, keyed by AgentDefinition.id. Agents without an entry have no projection. */
export const AGENT_PERMISSION_MAPPINGS: ReadonlyMap<string, AgentPermissionMapping> = new Map([
  ['claude', CLAUDE_PERMISSION_MAPPING],
  ['codex', CODEX_PERMISSION_MAPPING],
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

  const config = mapping.buildConfig?.(profile)
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
