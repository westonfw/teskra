import type { IpcResult } from '@teskra/contracts'

import { toPublicError } from '../../errors'

/**
 * §13.2 reserved env keys (TASK-100) — the reusable rejection check.
 *
 * Every AgentAccountProfileAdapter declares the env keys it owns when
 * projecting a profile (Codex: CODEX_HOME, Claude: CLAUDE_CONFIG_DIR, Kimi:
 * KIMI_CODE_HOME). Those
 * keys are reserved: if a workspace config, a Run request, or (TASK-111) a
 * Workflow definition could set them, it would silently retarget the Run at
 * another account's CLI home while looking perfectly normal. Any occurrence
 * is REJECTED — never silently dropped — and the caller logs the rejection.
 *
 * Keys are compared case-insensitively (both sides folded to upper case). The
 * §13.1 "profile writes its own casing last, so it wins" defense does NOT hold
 * on Windows: node-pty serializes the env block in insertion order without
 * deduplicating, and the Windows environment lookup is case-insensitive and
 * returns the FIRST match — so a lowercase `codex_home` inserted before the
 * profile's `CODEX_HOME` wins (reproduced on Windows 11, see
 * docs/code-review-2026-09-21.md §2 P0-1). Case variants are therefore
 * rejected on every runtime; on Linux/WSL, where env is case-sensitive,
 * rejecting `codex_home` is harmless.
 */
export function assertNoReservedEnvKeys(
  env: Readonly<Record<string, unknown>> | undefined,
  source: string,
  reservedKeys: readonly string[],
): IpcResult<void> {
  if (env === undefined || reservedKeys.length === 0) {
    return { ok: true, data: undefined }
  }
  const reserved = new Set(reservedKeys.map((key) => key.toUpperCase()))
  const offenders = Object.keys(env).filter((key) => reserved.has(key.toUpperCase()))
  if (offenders.length === 0) {
    return { ok: true, data: undefined }
  }
  return {
    ok: false,
    error: toPublicError({
      code: 'VALIDATION_FAILED',
      message: `${source} may not set reserved account-profile variable(s): ${offenders.join(', ')}. Remove them — the account profile owns these.`,
      retryable: false,
      detail: `reserved env keys ${offenders.join(', ')} present in ${source}`,
    }),
  }
}
