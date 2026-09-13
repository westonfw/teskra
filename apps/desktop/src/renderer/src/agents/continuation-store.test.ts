import type { AgentAccountProfile, AgentRun, IpcResult } from '@teskra/contracts'
import { describe, expect, it, vi } from 'vitest'

import { createContinuationStore, type ContinuationStoreBridge } from './continuation-store'

const AT = '2026-09-10T00:00:00.000Z'

function makeProfile(overrides: Partial<AgentAccountProfile>): AgentAccountProfile {
  return {
    id: 'acct-1',
    agentId: 'codex',
    name: 'Personal',
    authType: 'subscription',
    runtime: { kind: 'windows' },
    status: 'ready',
    enabled: true,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  }
}

const sourceRun: AgentRun = {
  id: 'run-1',
  taskId: 'task-1',
  workspaceId: 'workspace-1',
  agentType: 'codex',
  accountProfileId: 'acct-limited',
  status: 'failed',
  failureClassification: { kind: 'rate-limited', retryable: true },
  executionMode: 'attended',
  runDir: '/runs/run-1',
  createdAt: AT,
  updatedAt: AT,
}

const continuedRun: AgentRun = {
  ...sourceRun,
  id: 'run-2',
  accountProfileId: 'acct-work',
  status: 'created',
  failureClassification: undefined,
}

function makeBridge(overrides?: {
  list?: ContinuationStoreBridge['account']['list']
  continueWithProfile?: ContinuationStoreBridge['agent']['continueWithProfile']
}): ContinuationStoreBridge {
  return {
    account: {
      list: overrides?.list ?? vi.fn(async () => ({ ok: true as const, data: [] })),
    },
    agent: {
      continueWithProfile:
        overrides?.continueWithProfile ??
        vi.fn(async () => ({ ok: true as const, data: continuedRun })),
    },
  }
}

describe('continuation store (TASK-108)', () => {
  it('openFor opens the modal and refreshes candidates via account.list (§18.0 sweep)', async () => {
    const profiles = [makeProfile({ id: 'acct-work', name: 'Work' })]
    const list = vi.fn(async (): Promise<IpcResult<AgentAccountProfile[]>> => ({
      ok: true,
      data: profiles,
    }))
    const store = createContinuationStore(() => makeBridge({ list }))

    store.getState().openFor(sourceRun)
    expect(store.getState().open).toBe(true)
    expect(store.getState().sourceRun?.id).toBe('run-1')
    await vi.waitFor(() => expect(store.getState().refreshing).toBe(false))

    expect(list).toHaveBeenCalledTimes(1)
    expect(store.getState().profiles.map(({ id }) => id)).toEqual(['acct-work'])
  })

  it('continueWith calls continueWithProfile and closes on success', async () => {
    const continueWithProfile = vi.fn(async (): Promise<IpcResult<AgentRun>> => ({
      ok: true,
      data: continuedRun,
    }))
    const store = createContinuationStore(() => makeBridge({ continueWithProfile }))
    store.getState().openFor(sourceRun)

    const created = await store.getState().continueWith('codex', 'acct-work')

    expect(continueWithProfile).toHaveBeenCalledWith({
      sourceRunId: 'run-1',
      targetAgentId: 'codex',
      targetAccountProfileId: 'acct-work',
    })
    expect(created?.id).toBe('run-2')
    expect(store.getState().open).toBe(false)
    expect(store.getState().sourceRun).toBeUndefined()
    expect(store.getState().error).toBeUndefined()
  })

  it('keeps the modal open and exposes the error when continuation fails', async () => {
    const continueWithProfile = vi.fn(async (): Promise<IpcResult<AgentRun>> => ({
      ok: false,
      error: { code: 'CONFLICT', message: 'source process still alive', retryable: true },
    }))
    const store = createContinuationStore(() => makeBridge({ continueWithProfile }))
    store.getState().openFor(sourceRun)

    const created = await store.getState().continueWith('codex', 'acct-work')

    expect(created).toBeUndefined()
    expect(store.getState().open).toBe(true)
    expect(store.getState().submitting).toBe(false)
    expect(store.getState().error?.code).toBe('CONFLICT')

    store.getState().clearError()
    expect(store.getState().error).toBeUndefined()
  })

  it('does nothing without a source run', async () => {
    const continueWithProfile = vi.fn()
    const store = createContinuationStore(() =>
      makeBridge({
        continueWithProfile:
          continueWithProfile as ContinuationStoreBridge['agent']['continueWithProfile'],
      }),
    )
    expect(await store.getState().continueWith('codex', 'acct-work')).toBeUndefined()
    expect(continueWithProfile).not.toHaveBeenCalled()
  })

  it('close resets the modal and discards a late refresh', async () => {
    let resolveList: ((result: IpcResult<AgentAccountProfile[]>) => void) | undefined
    const list = vi.fn(
      () =>
        new Promise<IpcResult<AgentAccountProfile[]>>((resolve) => {
          resolveList = resolve
        }),
    )
    const store = createContinuationStore(() => makeBridge({ list }))
    store.getState().openFor(sourceRun)
    store.getState().close()

    resolveList?.({ ok: true, data: [makeProfile({})] })
    await Promise.resolve()

    expect(store.getState().open).toBe(false)
    expect(store.getState().profiles).toEqual([])
    expect(store.getState().refreshing).toBe(false)
  })
})
