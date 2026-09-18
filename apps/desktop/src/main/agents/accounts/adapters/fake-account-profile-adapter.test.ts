import { describe, expect, it } from 'vitest'

import type { AgentAccountProfile, IpcResult, WorkspaceRuntimeRef } from '@teskra/contracts'

import type { WorkspaceRuntime } from '../../../workspace/runtime'
import { FAKE_AGENT } from '../../definitions/fake'
import { FAKE_HOME_ENV_KEY, createFakeAccountProfileAdapter } from './fake-account-profile-adapter'

/**
 * TASK-115 — the development-only Fake Agent account profile adapter:
 * verbatim FAKE_HOME projection, deterministic detectStatus, and the no-op
 * login command. The end-to-end lifecycle it unlocks (profile-pinned Fake
 * Agent run → rate-limit classification → Limited → Continue) lives in
 * apps/desktop/e2e/specs/account-profile.spec.ts.
 */

function makeProfile(overrides: Partial<AgentAccountProfile> = {}): AgentAccountProfile {
  return {
    id: 'acct_fake_a',
    agentId: FAKE_AGENT.id,
    name: 'Fake A',
    authType: 'subscription',
    runtime: { kind: 'windows' },
    configHome: 'C:\\Users\\u\\.teskra\\agent-profiles\\fake\\fake-a',
    status: 'login-required',
    enabled: true,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...overrides,
  }
}

function requireOk<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

/** Minimal WorkspaceRuntime stub — buildRuntimeProjection must not consult it. */
const STUB_RUNTIME: WorkspaceRuntime = {
  ref: { kind: 'windows' } satisfies WorkspaceRuntimeRef,
  hostNative: true,
  resolveCommand: (command, args = [], cwd) => ({
    executable: command,
    args,
    ...(cwd !== undefined ? { cwd } : {}),
  }),
  resolveTerminal: () => ({ ok: true, data: { command: 'bash', args: ['-l'] } }),
  resolveCwd: (path) => path,
  resolveHostPath: (path) => ({ ok: true, data: path }),
  resolveDataRoot: () => 'C:\\Users\\u\\.teskra',
  resolveAgentProfilesRoot: () => 'C:\\Users\\u\\.teskra\\agent-profiles',
  resolveAgentProfileHome: (agentId, slug) => ({
    ok: true,
    data: `C:\\Users\\u\\.teskra\\agent-profiles\\${agentId}\\${slug}`,
  }),
  validate: () => ({ ok: true, data: { kind: 'windows', hostNative: true } }),
}

describe('FakeAccountProfileAdapter (TASK-115)', () => {
  it('takes agentId and reservedEnvKeys from the Fake Agent definition', () => {
    const adapter = createFakeAccountProfileAdapter()
    expect(adapter.agentId).toBe(FAKE_AGENT.id)
    expect(adapter.reservedEnvKeys).toEqual([FAKE_HOME_ENV_KEY])
  })

  it('projects the configHome verbatim into FAKE_HOME', () => {
    const adapter = createFakeAccountProfileAdapter()
    const profile = makeProfile()
    const projection = requireOk(adapter.buildRuntimeProjection(profile, STUB_RUNTIME))
    expect(projection.env).toEqual({ [FAKE_HOME_ENV_KEY]: profile.configHome })
  })

  it('rejects profiles of other agents and profiles without a configHome', () => {
    const adapter = createFakeAccountProfileAdapter()
    const foreign = adapter.buildRuntimeProjection(makeProfile({ agentId: 'codex' }), STUB_RUNTIME)
    expect(foreign.ok).toBe(false)
    const homeless = adapter.buildRuntimeProjection(
      makeProfile({ configHome: undefined }),
      STUB_RUNTIME,
    )
    expect(homeless.ok).toBe(false)
  })

  it('detects ready with a configHome and unknown without one', async () => {
    const adapter = createFakeAccountProfileAdapter()
    expect(requireOk(await adapter.detectStatus(makeProfile()))).toEqual({ status: 'ready' })
    expect(requireOk(await adapter.detectStatus(makeProfile({ configHome: undefined })))).toEqual({
      status: 'unknown',
    })
  })

  it('builds a no-op login command for managed profiles only', () => {
    const adapter = createFakeAccountProfileAdapter()
    expect(requireOk(adapter.buildLoginCommand(makeProfile()))).toEqual({
      command: FAKE_AGENT.executable.command,
      args: ['--version'],
    })
    expect(adapter.buildLoginCommand(makeProfile({ configHome: undefined })).ok).toBe(false)
  })
})
