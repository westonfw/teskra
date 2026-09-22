import type { ThreadItem } from '@teskra/contracts'

/**
 * TASK-140 (teskra-tasks.md; Milestone 26 design §8) — the pure merge logic
 * behind the Task page Thread tab. The projection behind `teskra:task:thread`
 * is a read model without per-run selectors, so live updates (`agent.*`,
 * `decision.*`, `workflow.run_updated`) re-read the projection and MERGE the
 * result into the rendered list by projection id: new items slot into cursor
 * order, changed items (a resolved Decision, a longer agent_reply, a new
 * status) replace their previous entry in place. The list identity, scroll
 * position and expanded cards survive — nothing is torn down and re-pulled
 * wholesale.
 */

function compareThreadItems(left: ThreadItem, right: ThreadItem): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1
  }
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

function sameThreadItem(left: ThreadItem, right: ThreadItem): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Upserts `incoming` into `existing` keyed on the projection id and returns
 * the list in stable `(createdAt, id)` cursor order. When nothing actually
 * changed (the typical event storm during a run) the ORIGINAL array reference
 * comes back so React skips the re-render.
 */
export function mergeThreadItems(
  existing: readonly ThreadItem[],
  incoming: readonly ThreadItem[],
): readonly ThreadItem[] {
  if (incoming.length === 0) return existing
  const merged = new Map<string, ThreadItem>(existing.map((item) => [item.id, item]))
  let changed = false
  for (const item of incoming) {
    const previous = merged.get(item.id)
    if (previous === undefined || !sameThreadItem(previous, item)) {
      merged.set(item.id, item)
      changed = true
    }
  }
  if (!changed && merged.size === existing.length) return existing
  return [...merged.values()].sort(compareThreadItems)
}

/**
 * Drops items whose projection id is gone from the latest projection read
 * (a deleted run's rows). Applied on full refreshes only — incremental event
 * merges never prune, so a transient read failure cannot blank the thread.
 */
export function reconcileThreadItems(
  existing: readonly ThreadItem[],
  projection: readonly ThreadItem[],
): readonly ThreadItem[] {
  const projectionIds = new Set(projection.map((item) => item.id))
  const pruned = existing.filter((item) => projectionIds.has(item.id))
  return mergeThreadItems(pruned, projection)
}
