import { z } from 'zod'

import type { IpcResult, PublicAppError } from '@teskra/contracts'

import { type InternalAppError, toPublicError } from '../../errors'

/**
 * Shared mapping helpers for the Repository layer (TASK-007).
 *
 * Repositories are the ONLY place in the Main process allowed to hold SQL
 * statements (teskra-tasks.md TASK-007: "Manager 层不直接写 SQL"). Everything
 * here serves the three mapping duties from the acceptance criteria:
 *
 * - Row ↔ Domain object mapping, including `*_json` column decoding with
 *   Zod validation. Corrupted JSON or schema mismatches come back as
 *   structured `IpcResult` errors (VALIDATION_FAILED), never raw throws.
 * - Timestamp columns are ISO-8601 UTC text. Writes go through `nowIso()`
 *   (`Date#toISOString`), reads validate the exact format — create/update
 *   re-read the row through the validating read path, so a malformed write
 *   can never leave the layer unchallenged.
 * - better-sqlite3 driver errors (constraint violations etc.) are caught by
 *   `execute()` and converted to structured errors.
 */

/** Matches `Date#toISOString()` output exactly: ISO-8601 UTC, ms precision. */
export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export const isoTimestampSchema = z.string().regex(ISO_UTC_PATTERN)

/** Generic schema for opaque `*_json` columns holding a JSON object. */
export const jsonRecordSchema = z.record(z.string(), z.unknown())
export type JsonRecord = z.infer<typeof jsonRecordSchema>

/** The single write-side clock. Always ISO-8601 UTC. */
export function nowIso(): string {
  return new Date().toISOString()
}

function repositoryError(
  message: string,
  detail: string,
  cause?: unknown,
  code: InternalAppError['code'] = 'UNKNOWN',
): PublicAppError {
  return toPublicError({ code, message, retryable: false, detail, cause })
}

/**
 * Wraps a synchronous better-sqlite3 call. A thrown driver error becomes a
 * structured UNKNOWN error; nothing escapes as a raw exception.
 */
export function execute<T>(entity: string, operation: string, fn: () => T): IpcResult<T> {
  try {
    return { ok: true, data: fn() }
  } catch (cause) {
    return {
      ok: false,
      error: repositoryError(`Failed to ${operation} ${entity}.`, `${entity}: ${operation}`, cause),
    }
  }
}

/**
 * Validates a mapped row candidate against its Zod schema. A mismatch means
 * the stored data is corrupted or the schema drifted — either way the caller
 * gets VALIDATION_FAILED with the issue list in the (log-only) detail.
 */
export function validateRow<T>(
  schema: z.ZodType<T>,
  entity: string,
  candidate: unknown,
): IpcResult<T> {
  const parsed = schema.safeParse(candidate)
  if (!parsed.success) {
    return {
      ok: false,
      error: repositoryError(
        `Stored ${entity} data failed schema validation.`,
        `${entity}: ${JSON.stringify(parsed.error.issues)}`,
        undefined,
        'VALIDATION_FAILED',
      ),
    }
  }
  return { ok: true, data: parsed.data }
}

/**
 * Decodes a nullable `*_json` column: JSON.parse + Zod validation.
 * NULL decodes to `undefined`. Corrupted text or schema mismatches return
 * VALIDATION_FAILED instead of throwing.
 */
export function decodeJson<T>(
  schema: z.ZodType<T>,
  entity: string,
  column: string,
  raw: string | null,
): IpcResult<T | undefined> {
  if (raw === null) {
    return { ok: true, data: undefined }
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (cause) {
    return {
      ok: false,
      error: repositoryError(
        `Stored ${entity} data contains corrupted JSON.`,
        `${entity}.${column}: invalid JSON text`,
        cause,
        'VALIDATION_FAILED',
      ),
    }
  }
  return validateRow(schema, `${entity}.${column}`, value)
}

/**
 * Create/upsert paths re-read the just-written row through the validating
 * read path (so writes get the same Zod checks). The row cannot legitimately
 * be missing right after its own write; if it is, that is an internal
 * inconsistency, surfaced as UNKNOWN rather than a lying `null`.
 */
export function requireFound<T>(entity: string, result: IpcResult<T | null>): IpcResult<T> {
  if (!result.ok) {
    return result
  }
  if (result.data === null) {
    return {
      ok: false,
      error: repositoryError(
        `Failed to read back ${entity} after writing it.`,
        `${entity}: row missing immediately after write`,
      ),
    }
  }
  return { ok: true, data: result.data }
}

/** Serializes a `*_json` column for writing; `undefined` maps to NULL. */
export function encodeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

/**
 * Maps every row through `map`; the first mapping failure fails the whole
 * call so a list never silently drops or half-parses corrupted rows.
 */
export function mapRows<Row, T>(
  rows: readonly Row[],
  map: (row: Row) => IpcResult<T>,
): IpcResult<T[]> {
  const out: T[] = []
  for (const row of rows) {
    const mapped = map(row)
    if (!mapped.ok) {
      return mapped
    }
    out.push(mapped.data)
  }
  return { ok: true, data: out }
}
