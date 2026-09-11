import type { PermissionAuditEntry, PermissionEnforcement } from '@teskra/contracts'

/**
 * TASK-066 — pure view-model for the Permission UI. Kept component-free so
 * the conditional rendering rules (who sees the approval UI, which risks are
 * highlighted) are directly unit-testable.
 *
 * ADR-0002 reminder baked into the copy: audit rows are recognized AFTER the
 * command ran; only `native` Agents have a real approval prompt.
 */

export interface PermissionEnforcementInfo {
  readonly mode: PermissionEnforcement
  /** True only when the Agent CLI has its own approval prompt Teskra can target. */
  readonly canPrompt: boolean
  readonly label: string
  readonly description: string
}

const ENFORCEMENT_INFO: Record<PermissionEnforcement, PermissionEnforcementInfo> = {
  native: {
    mode: 'native',
    canPrompt: true,
    label: 'Native approval',
    description:
      'The Agent CLI asks for approval itself. Teskra projects your rules into the CLI’s own permission settings before each Run and can record approval decisions.',
  },
  config: {
    mode: 'config',
    canPrompt: false,
    label: 'Config projection only',
    description:
      'Teskra translates rules into this CLI’s launch configuration. The CLI cannot be prompted mid-run, so “ask” rules degrade to audit-only. Commands shown in the Commands tab were already executed when recognized.',
  },
  none: {
    mode: 'none',
    canPrompt: false,
    label: 'No enforcement',
    description:
      'This Agent has no permission mechanism Teskra can target. Isolation (worktrees) and post-hoc audit are the only safeguards; nothing here constrains what the Agent runs.',
  },
}

export function permissionEnforcementInfo(
  mode: PermissionEnforcement,
): PermissionEnforcementInfo {
  return ENFORCEMENT_INFO[mode]
}

/** Approval UI is shown only for native Agents — anything else would pretend to intercept. */
export function canUseApprovalUi(mode: PermissionEnforcement): boolean {
  return ENFORCEMENT_INFO[mode].canPrompt
}

/** Risks that get a pinned warning on top of the Commands tab. */
export const ELEVATED_RISKS = ['DESTRUCTIVE', 'NETWORK_WRITE'] as const

export function isElevatedRisk(riskLevel: string): boolean {
  return (ELEVATED_RISKS as readonly string[]).includes(riskLevel)
}

export function riskTagColor(riskLevel: string): string {
  switch (riskLevel) {
    case 'READ_ONLY':
      return 'green'
    case 'WORKSPACE_WRITE':
      return 'blue'
    case 'NETWORK_WRITE':
      return 'orange'
    case 'SYSTEM_WRITE':
      return 'volcano'
    case 'DESTRUCTIVE':
      return 'red'
    default:
      return 'default'
  }
}

/** Elevated-risk entries of one Run, chronological (for the pinned summary). */
export function elevatedEntries(
  entries: readonly PermissionAuditEntry[],
): PermissionAuditEntry[] {
  return entries.filter((entry) => isElevatedRisk(entry.riskLevel))
}
