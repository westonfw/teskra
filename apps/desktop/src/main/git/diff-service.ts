import type {
  DiffFileStatus,
  DiffFileSummary,
  DiffResult,
  GitRawDiff,
  IpcResult,
} from '@teskra/contracts'

import type { GitManager, GitNumstatEntry } from './git-manager'

export interface DiffService {
  /**
   * Changes list: identity + line stats per file, gathered in a constant
   * number of git spawns (status + staged/unstaged numstat). Patch bodies are
   * NOT included — the renderer fetches them per file via getFilePatch.
   */
  get(workspaceId: string): Promise<IpcResult<DiffResult>>
  /** Lazy single-file patch for the changes list (P1-5). */
  getFilePatch(workspaceId: string, path: string): Promise<IpcResult<GitRawDiff>>
}

export interface DiffServiceDeps {
  readonly git: Pick<
    GitManager,
    'status' | 'diff' | 'diffNumstat' | 'untrackedDiff' | 'untrackedNumstat'
  >
}

function fileStatus(code: string): DiffFileStatus {
  if (code === '??' || code.includes('A')) return 'added'
  if (code.includes('D')) return 'deleted'
  if (code.includes('R') || code.includes('C')) return 'renamed'
  return 'modified'
}

function emptyStats(): { additions: number; deletions: number } {
  return { additions: 0, deletions: 0 }
}

// status runs with --untracked-files=all, so an un-ignored node_modules/dist
// can yield thousands of untracked entries; each probe is a git spawn, so the
// fan-out must stay bounded (review follow-up: unbounded Promise.all forked
// one process per file).
export const UNTRACKED_STAT_CONCURRENCY = 8

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

/** TASK-036: converts raw Git output into renderer-safe, per-file DiffResult records. */
export function createDiffService(deps: DiffServiceDeps): DiffService {
  return {
    async get(workspaceId) {
      const status = await deps.git.status(workspaceId)
      if (!status.ok) return status

      // One spawn per side of the index for every tracked file at once; the
      // untracked stat probes below return a one-line numstat each, never a
      // full patch.
      const [staged, unstaged] = await Promise.all([
        deps.git.diffNumstat({ workspaceId, staged: true }),
        deps.git.diffNumstat({ workspaceId }),
      ])
      if (!staged.ok) return staged
      if (!unstaged.ok) return unstaged
      const stats = new Map<string, { additions: number; deletions: number }>()
      for (const entry of [...unstaged.data, ...staged.data]) {
        const existing = stats.get(entry.path) ?? emptyStats()
        stats.set(entry.path, {
          additions: existing.additions + entry.additions,
          deletions: existing.deletions + entry.deletions,
        })
      }

      const untrackedStats = new Map<string, GitNumstatEntry>()
      const untrackedEntries = status.data.entries.filter((entry) => entry.code === '??')
      const probed = await mapWithConcurrency(
        untrackedEntries,
        UNTRACKED_STAT_CONCURRENCY,
        (entry) => deps.git.untrackedNumstat(workspaceId, entry.path),
      )
      for (const [index, entry] of untrackedEntries.entries()) {
        const result = probed[index] as IpcResult<GitNumstatEntry>
        if (!result.ok) return result
        untrackedStats.set(entry.path, result.data)
      }

      const files: DiffFileSummary[] = status.data.entries.map((entry) => ({
        path: entry.path,
        status: fileStatus(entry.code),
        ...(entry.code === '??'
          ? (untrackedStats.get(entry.path) ?? emptyStats())
          : (stats.get(entry.path) ?? emptyStats())),
      }))
      return { ok: true, data: { files } }
    },

    async getFilePatch(workspaceId, path) {
      const status = await deps.git.status(workspaceId)
      if (!status.ok) return status
      const entry = status.data.entries.find((candidate) => candidate.path === path)
      // The file is no longer changed (list is stale): an empty patch, not an
      // error — the next refresh drops the row anyway.
      if (entry === undefined) return { ok: true, data: { patch: '' } }
      if (entry.code === '??') return deps.git.untrackedDiff(workspaceId, path)
      const [staged, unstaged] = await Promise.all([
        deps.git.diff({ workspaceId, path, staged: true }),
        deps.git.diff({ workspaceId, path }),
      ])
      if (!staged.ok) return staged
      if (!unstaged.ok) return unstaged
      return { ok: true, data: { patch: `${staged.data.patch}${unstaged.data.patch}` } }
    },
  }
}
