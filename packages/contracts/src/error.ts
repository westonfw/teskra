import { z } from 'zod'

/**
 * Unified error model (teskra-tasks.md §0 / TASK-003).
 *
 * IPC never throws across processes — every channel returns `IpcResult<T>`.
 * `PublicAppError` structurally has no `detail` / `cause` fields, so internal
 * details cannot leak to the Renderer by construction. `InternalAppError`
 * lives Main-side only (apps/desktop/src/main/errors.ts) and is deliberately
 * NOT part of this package.
 */
export const ERROR_CODES = [
  'WORKSPACE_NOT_FOUND',
  'WSL_NOT_AVAILABLE',
  'WSL_DISTRO_NOT_FOUND',
  'AGENT_NOT_INSTALLED',
  'CAPABILITY_NOT_AVAILABLE',
  'COMMAND_TIMEOUT',
  'PROCESS_NOT_FOUND',
  'TERMINAL_NOT_FOUND',
  'MERGE_BLOCKED',
  'VALIDATION_FAILED',
  /** A uniqueness / state precondition conflicted (e.g. duplicate configHome). */
  'CONFLICT',
  /**
   * Milestone 24 (§37): account-profile resolution failures, kept as distinct
   * codes so a wrong profile id can never be mistaken for a generic bad
   * request (TASK-100 cross-object constraints).
   */
  'ACCOUNT_PROFILE_NOT_FOUND',
  /** The profile belongs to a different agent than the Run requests. */
  'ACCOUNT_PROFILE_MISMATCH',
  'ACCOUNT_PROFILE_DISABLED',
  /** The profile's runtime cannot host the workspace runtime. */
  'ACCOUNT_PROFILE_INCOMPATIBLE',
  'UNKNOWN',
] as const

export const errorCodeSchema = z.enum(ERROR_CODES)
export type ErrorCode = z.infer<typeof errorCodeSchema>

/**
 * The only error shape allowed to cross IPC. `.strictObject` is load-bearing:
 * a payload carrying `detail` / `cause` fails validation instead of leaking.
 */
export const publicAppErrorSchema = z.strictObject({
  code: errorCodeSchema,
  /**
   * User-facing message, safe to display directly. When `messageKey` is set
   * this is only the fallback used when the Renderer cannot resolve the key.
   */
  message: z.string(),
  retryable: z.boolean(),
  /**
   * Optional Renderer dictionary key (en-US / zh-CN, `errorMessage.*`); when
   * present the Renderer localizes the message instead of showing `message`.
   */
  messageKey: z.string().optional(),
  /** Interpolation params for `messageKey` — string/number values only. */
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
})
export type PublicAppError = z.infer<typeof publicAppErrorSchema>

/** Unified IPC envelope — structurally cannot carry detail / cause. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: PublicAppError }

export function ipcResultSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.union([
    z.strictObject({ ok: z.literal(true), data: dataSchema }),
    z.strictObject({ ok: z.literal(false), error: publicAppErrorSchema }),
  ])
}
