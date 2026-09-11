import type { BuiltContext, Memory, PublicAppError } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createMemoryStore, type MemoryStoreBridge } from './memory-store'

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'memory-1',
    workspaceId: 'workspace-1',
    type: 'summary',
    content: 'Remember this.',
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

function builtContext(overrides: Partial<BuiltContext> = {}): BuiltContext {
  return {
    workspaceId: 'workspace-1',
    budgetChars: 8_000,
    totalChars: 12,
    omittedCount: 0,
    parts: [{ key: 'memory:memory-1', content: 'Remember this.', chars: 12 }],
    content: 'Remember this.',
    ...overrides,
  }
}

const failure: PublicAppError = {
  code: 'WORKSPACE_NOT_FOUND',
  message: 'The workspace is gone.',
  retryable: false,
}

function bridge(overrides: Partial<MemoryStoreBridge['context']> = {}): MemoryStoreBridge {
  return {
    memory: {
      list: vi.fn(async () => ({ ok: true as const, data: [memory()] })),
      create: vi.fn(async () => ({ ok: true as const, data: memory() })),
      update: vi.fn(async () => ({ ok: true as const, data: memory() })),
      delete: vi.fn(async () => ({ ok: true as const, data: true })),
    },
    context: {
      preview: vi.fn(async () => ({ ok: true as const, data: builtContext() })),
      ...overrides,
    },
  }
}

describe('memory store', () => {
  it('lists memories for a workspace', async () => {
    const store = createMemoryStore(() => bridge())
    await store.getState().synchronize('workspace-1')
    expect(store.getState().memories).toHaveLength(1)
    expect(store.getState().loading).toBe(false)
  })

  it('returns the built context on a successful preview', async () => {
    const store = createMemoryStore(() => bridge())
    const built = await store.getState().previewContext({ workspaceId: 'workspace-1' })
    expect(built?.content).toBe('Remember this.')
    expect(store.getState().error).toBeUndefined()
  })

  it('surfaces a failed preview instead of swallowing it', async () => {
    // Regression: the Memory panel ignored a non-ok preview result, so
    // "Preview context" did nothing at all when the preview failed.
    const store = createMemoryStore(() =>
      bridge({ preview: vi.fn(async () => ({ ok: false as const, error: failure })) }),
    )
    const built = await store.getState().previewContext({ workspaceId: 'workspace-1' })
    expect(built).toBeUndefined()
    expect(store.getState().error).toEqual(failure)
  })

  it('surfaces a transport failure during preview', async () => {
    const store = createMemoryStore(() =>
      bridge({
        preview: vi.fn(() => Promise.reject(new Error('ipc down'))),
      }),
    )
    const built = await store.getState().previewContext({ workspaceId: 'workspace-1' })
    expect(built).toBeUndefined()
    expect(store.getState().error?.code).toBe('UNKNOWN')
  })
})
