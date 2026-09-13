import type { IpcResult } from '@teskra/contracts'

import { toPublicError } from '../../errors'

/**
 * §13.2 reserved env keys (TASK-100) — the reusable rejection check.
 *
 * Every AgentAccountProfileAdapter declares the env keys it owns when
 * projecting a profile (Codex: CODEX_HOME, Claude: CLAUDE_CONFIG_DIR). Those
 * keys are reserved: if a workspace config, a Run request, or (TASK-111) a
 * Workflow definition could set them, it would silently retarget the Run at
 * another account's CLI home while looking perfectly normal. Any occurrence
 * is REJECTED — never silently dropped — and the caller logs the rejection.
 *
 * Keys are compared case-sensitively: env vars on Linux/WSL are
 * case-sensitive, and on Windows node-pty passes the profile's own casing
 * last (§13.1), which wins regardless.
 */
export function assertNoReservedEnvKeys(
  env: Readonly<Record<string, unknown>> | undefined,
  source: string,
  reservedKeys: readonly string[],
): IpcResult<void> {
  if (env === undefined || reservedKeys.length === 0) {
    return { ok: true, data: undefined }
  }
  const reserved = new Set(reservedKeys)
  const offenders = Object.keys(env).filter((key) => reserved.has(key))
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
