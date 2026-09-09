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
  'MERGE_BLOCKED',
  'VALIDATION_FAILED',
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
  /** User-facing message, safe to display directly. */
  message: z.string(),
  retryable: z.boolean(),
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
