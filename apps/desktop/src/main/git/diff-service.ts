import type { DiffFile, DiffFileStatus, DiffResult, IpcResult } from '@teskra/contracts'

import type { GitManager } from './git-manager'

export interface DiffService {
  get(workspaceId: string): Promise<IpcResult<DiffResult>>
}

export interface DiffServiceDeps {
  readonly git: Pick<GitManager, 'status' | 'diff' | 'untrackedDiff'>
}

function fileStatus(code: string): DiffFileStatus {
  if (code === '??' || code.includes('A')) return 'added'
  if (code.includes('D')) return 'deleted'
  if (code.includes('R') || code.includes('C')) return 'renamed'
  return 'modified'
}

function lineStats(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions }
}

/** TASK-036: converts raw Git output into renderer-safe, per-file DiffResult records. */
export function createDiffService(deps: DiffServiceDeps): DiffService {
  return {
    async get(workspaceId) {
      const status = await deps.git.status(workspaceId)
      if (!status.ok) return status
      const files: DiffFile[] = []

      for (const entry of status.data.entries) {
        const kind = fileStatus(entry.code)
        let patch: IpcResult<{ patch: string }>
        if (entry.code === '??') {
          patch = await deps.git.untrackedDiff(workspaceId, entry.path)
        } else {
          const [staged, unstaged] = await Promise.all([
            deps.git.diff({ workspaceId, path: entry.path, staged: true }),
            deps.git.diff({ workspaceId, path: entry.path }),
          ])
          if (!staged.ok) return staged
          if (!unstaged.ok) return unstaged
          patch = { ok: true, data: { patch: `${staged.data.patch}${unstaged.data.patch}` } }
        }
        if (!patch.ok) return patch
        files.push({
          path: entry.path,
          status: kind,
          ...lineStats(patch.data.patch),
          patch: patch.data.patch,
        })
      }

      return { ok: true, data: { files } }
    },
  }
}
