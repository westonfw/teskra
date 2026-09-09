import type { Workspace } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createWorkspaceStore, type WorkspaceStoreBridge } from './workspace-store'

const FIRST: Workspace = {
  id: 'workspace-1',
  name: 'Teskra',
  runtime: { kind: 'wsl', distro: 'Ubuntu' },
  path: '/repo/teskra',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}
const SECOND: Workspace = {
  ...FIRST,
  id: 'workspace-2',
  name: 'Desktop',
  runtime: { kind: 'windows' },
  path: 'C:\\repo\\desktop',
}

function bridge(): WorkspaceStoreBridge {
  return {
    workspace: {
      open: vi.fn(async () => ({ ok: true as const, data: FIRST })),
      remove: vi.fn(async () => ({ ok: true as const, data: true })),
      listRecent: vi.fn(async () => ({ ok: true as const, data: [SECOND, FIRST] })),
      selectDirectory: vi.fn(async () => ({ ok: true as const, data: 'C:\\repo\\desktop' })),
    },
  }
}

describe('workspace store', () => {
  it('loads recent workspaces and switches without duplicating entries', async () => {
    const api = bridge()
    const store = createWorkspaceStore(() => api)
    await store.getState().loadRecent()
    expect(store.getState().current?.id).toBe(SECOND.id)

    store.getState().selectWorkspace(FIRST.id)
    expect(store.getState().current?.id).toBe(FIRST.id)
    await store.getState().openWorkspace({ runtime: FIRST.runtime, path: FIRST.path })
    expect(store.getState().recent.map(({ id }) => id)).toEqual([FIRST.id, SECOND.id])
    expect(api.workspace.open).toHaveBeenCalledOnce()
  })

  it('removes the current workspace and selects the next recent item', async () => {
    const api = bridge()
    const store = createWorkspaceStore(() => api)
    await store.getState().loadRecent()
    expect(await store.getState().removeWorkspace(SECOND.id)).toBe(true)
    expect(store.getState().current?.id).toBe(FIRST.id)
    expect(store.getState().recent).toEqual([FIRST])
  })
})
