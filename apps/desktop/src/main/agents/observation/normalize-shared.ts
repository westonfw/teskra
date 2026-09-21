import type { AgentObservation } from '@teskra/contracts'

/**
 * Shared helpers for the structured-stream normalizers (TASK-123 §6.2).
 * Normalizers are pure per-line functions: they never throw on malformed
 * input — an unparseable or unknown line returns `undefined` and the recorder
 * counts it as ignored.
 */

/** The result of normalizing one NDJSON line. */
export type NormalizeResult = {
  readonly observations: AgentObservation[]
}

/**
 * Normalizes one line into zero or more observations. `undefined` means the
 * line was dropped (not JSON, unknown `type`, or failed shape checks) and is
 * counted into the run summary's `ignored` tally. A KNOWN line that carries
 * no observation (e.g. Codex `turn.started`) returns an empty list.
 */
export type ObservationNormalizer = (line: string) => NormalizeResult | undefined

/** JSON.parse that yields `undefined` instead of throwing. */
export function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return undefined
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Truncates an observation payload to its cap (characters). */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/** Serializes a tool payload for an observation; non-JSON values degrade to String(). */
export function serializePayload(value: unknown, max: number): string {
  if (typeof value === 'string') return truncate(value, max)
  let serialized: string
  try {
    serialized = JSON.stringify(value) ?? String(value)
  } catch {
    serialized = String(value)
  }
  return truncate(serialized, max)
}
