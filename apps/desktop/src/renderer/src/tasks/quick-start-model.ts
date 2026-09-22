import type {
  PublicAppError,
  ResolvedRunDefaults,
  RunDefaultReason,
  SendTaskMessageOverrides,
  SendTaskMessageRequest,
} from '@teskra/contracts'

import { hasTranslationKey, type Translation } from '../i18n'

/**
 * TASK-135 (Milestone 26 §12) — the pure model behind QuickStartInput: how
 * the resolved defaults render as the one-line gray summary, and how the
 * expandable editor's edits become the per-send `overrides` of the
 * `teskra:task:send-message` request.
 */

/** Edits from the expandable defaults row; they apply to the next send only. */
export interface QuickStartEdits {
  readonly agentType?: string | undefined
  /** Explicit account profile; undefined = auto (resolved default / CLI home). */
  readonly accountProfileId?: string | undefined
}

/**
 * A resolve-defaults VALIDATION_FAILED is the "no available Agent" answer
 * (TASK-134 fallback level 5): the input is disabled and the UI links to
 * Settings → Agents. Any other error leaves the input usable — the send
 * itself surfaces it.
 */
export function isNoAgentAvailable(error: PublicAppError): boolean {
  return error.code === 'VALIDATION_FAILED'
}

/**
 * The request assembled for one send. Note what is NOT here: `mode`,
 * `executionMode` and `approvalMode` never leave the Renderer — the
 * thread-mode hard constraints (exec / orchestrated / safe-auto) are applied
 * Main-side, so the attended + manual combination cannot be assembled from
 * this entry point.
 */
export function buildSendMessageRequest(input: {
  readonly workspaceId: string
  readonly taskId?: string | undefined
  readonly text: string
  readonly edits?: QuickStartEdits | undefined
}): SendTaskMessageRequest {
  const overrides: SendTaskMessageOverrides = {
    ...(input.edits?.agentType === undefined ? {} : { agentType: input.edits.agentType }),
    ...(input.edits?.accountProfileId === undefined
      ? {}
      : { accountProfileId: input.edits.accountProfileId }),
  }
  return {
    workspaceId: input.workspaceId,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    text: input.text,
    ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
  }
}

/**
 * The gray defaults line: 「agent · 账号 · 模式 · 审批」. Mode and approval
 * are the fixed thread-mode values (design doc §12: isolated · safe-auto).
 */
export function formatRunDefaultsSummary(
  defaults: ResolvedRunDefaults,
  accountName: string | undefined,
  t: Translation['t'],
): string {
  const account =
    defaults.accountProfileId === undefined
      ? t('quickStart.account.auto')
      : (accountName ?? defaults.accountProfileId)
  return [
    defaults.agentType,
    account,
    t('quickStart.executionMode.orchestrated'),
    t('quickStart.approvalMode.safeAuto'),
  ].join(' · ')
}

/** One localized line per reason — the tooltip behind the defaults summary. */
export function runDefaultsReasonLines(
  reasons: readonly RunDefaultReason[],
  t: Translation['t'],
): string[] {
  return reasons.map((reason) =>
    hasTranslationKey(reason.key) ? t(reason.key, reason.params) : reason.key,
  )
}
