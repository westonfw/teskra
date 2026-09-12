import type { PermissionAuditEntry, PermissionEnforcement } from '@teskra/contracts'

import type { TranslationKey } from '../i18n'

type Translate = (key: TranslationKey) => string

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

const CAN_PROMPT: Record<PermissionEnforcement, boolean> = {
  native: true,
  config: false,
  none: false,
}

export function permissionEnforcementInfo(
  mode: PermissionEnforcement,
  t: Translate,
): PermissionEnforcementInfo {
  return {
    mode,
    canPrompt: CAN_PROMPT[mode],
    label: t(`permissions.enforcement.${mode}.label`),
    description: t(`permissions.enforcement.${mode}.description`),
  }
}

/** Approval UI is shown only for native Agents — anything else would pretend to intercept. */
export function canUseApprovalUi(mode: PermissionEnforcement): boolean {
  return CAN_PROMPT[mode]
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
export function elevatedEntries(entries: readonly PermissionAuditEntry[]): PermissionAuditEntry[] {
  return entries.filter((entry) => isElevatedRisk(entry.riskLevel))
}
