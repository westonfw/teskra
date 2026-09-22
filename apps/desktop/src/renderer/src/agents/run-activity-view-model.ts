import type { AgentObservation, AgentObservationRecord, AgentRun } from '@teskra/contracts'

/**
 * TASK-125 (Milestone 25 §14): presentation logic for the Run detail
 * `Activity` / `Progress` tabs. Pure functions only — the paged feed, the
 * tool-call pairing and the default-tab decision live here so the timeline
 * behaviour is testable without a DOM. Observation-only (ADR-0013): nothing
 * in this module mutates Run state.
 */

/** The tool-shaped variants of the observation union (not separately exported by contracts). */
export type ToolCallObservation = Extract<AgentObservation, { kind: 'tool_call' }>
export type ToolResultObservation = Extract<AgentObservation, { kind: 'tool_result' }>

/** Page size for `list-observations` / `list-progress` paging. */
export const RUN_FEED_PAGE_SIZE = 200

/** A seq-ordered window of persisted run events plus the forward cursor state. */
export interface RunFeedState<T extends { readonly seq: number }> {
  readonly records: readonly T[]
  /** True while the server may hold records newer than the loaded window. */
  readonly hasMore: boolean
}

export function initialRunFeedState<T extends { readonly seq: number }>(): RunFeedState<T> {
  return { records: [], hasMore: false }
}

/**
 * The `afterSeq` cursor for the next page. Records are kept ascending, so the
 * last one carries the highest seq; `undefined` fetches the first page.
 */
export function nextAfterSeq(records: readonly { readonly seq: number }[]): number | undefined {
  return records.length === 0 ? undefined : records[records.length - 1]?.seq
}

/**
 * Merges loaded records with newly arrived ones (a fetched page or a live
 * broadcast), deduped by seq and kept ascending. A live event racing an
 * in-flight page can arrive twice — the seq dedupe makes that a no-op and the
 * same array reference is returned so React skips the re-render.
 */
export function mergeFeedRecords<T extends { readonly seq: number }>(
  existing: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  if (incoming.length === 0) return existing
  const known = new Set(existing.map((record) => record.seq))
  const fresh = incoming.filter((record) => !known.has(record.seq))
  if (fresh.length === 0) return existing
  return [...existing, ...fresh].sort((left, right) => left.seq - right.seq)
}

/**
 * Applies one fetched page. `hasMore` follows the "full page" convention: a
 * page shorter than `limit` means the stream is caught up (anything newer
 * arrives via the live subscription, not another page).
 */
export function applyFeedPage<T extends { readonly seq: number }>(
  state: RunFeedState<T>,
  page: readonly T[],
  limit: number,
): RunFeedState<T> {
  return { records: mergeFeedRecords(state.records, page), hasMore: page.length >= limit }
}

/** Applies one live broadcast record without touching the paging cursor. */
export function applyLiveRecord<T extends { readonly seq: number }>(
  state: RunFeedState<T>,
  record: T,
): RunFeedState<T> {
  const records = mergeFeedRecords(state.records, [record])
  return records === state.records ? state : { ...state, records }
}

/** One rendered timeline row; a tool_call may carry its answering tool_result. */
export interface ActivityItem {
  readonly seq: number
  readonly createdAt: string
  readonly observation: AgentObservation
  readonly pairedResult?: ToolResultObservation | undefined
}

/**
 * Pairs each tool_result with the tool_call it answers so the timeline can
 * collapse input + result into one row. Matching prefers the earliest
 * unpaired call with the same tool name (Claude results carry `toolName` when
 * the normalizer could read it); results without a name pair FIFO. A result
 * with no pending call renders standalone.
 */
export function buildActivityItems(
  records: readonly AgentObservationRecord[],
): readonly ActivityItem[] {
  const items: ActivityItem[] = []
  const pending: number[] = []
  for (const record of records) {
    const observation = record.observation
    if (observation.kind === 'tool_result' && pending.length > 0) {
      let position = 0
      if (observation.toolName !== undefined) {
        const named = pending.findIndex((index) => {
          const call = items[index]?.observation
          return call?.kind === 'tool_call' && call.toolName === observation.toolName
        })
        if (named !== -1) position = named
      }
      const [index] = pending.splice(position, 1)
      const call = index === undefined ? undefined : items[index]
      if (call !== undefined) {
        items[index as number] = { ...call, pairedResult: observation }
        continue
      }
    }
    items.push({ seq: record.seq, createdAt: record.createdAt, observation })
    if (observation.kind === 'tool_call') pending.push(items.length - 1)
  }
  return items
}

/** Tab keys shared by both Run detail drawers; 'output' is the raw-output tab. */
export type RunDetailDefaultTab = 'output' | 'activity'

/**
 * TASK-125 acceptance: an exec run with a structured stream lands on the
 * Activity tab. The launch-time `structuredOutput` resolution is not persisted
 * on the Run record, so "has a structured stream" is read back from the data:
 * any persisted observation means the parser (TASK-123) was attached, which
 * only happens for exec runs whose launch resolved a non-`none` protocol.
 */
export function defaultRunDetailTab(
  run: Pick<AgentRun, 'mode'> | undefined,
  hasObservations: boolean,
): RunDetailDefaultTab {
  return run?.mode === 'exec' && hasObservations ? 'activity' : 'output'
}
