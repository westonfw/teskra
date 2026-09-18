import type { AgentAccountProfile, IpcResult } from '@teskra/contracts'

import { toPublicError } from '../../../errors'
import { FAKE_AGENT } from '../../definitions/fake'
import type {
  AccountProfileLoginCommand,
  AccountProfileRuntimeProjection,
  AccountProfileStatusDetection,
  AgentAccountProfileAdapter,
} from '../account-profile-adapter'

/**
 * FakeAccountProfileAdapter (TASK-115, Milestone 24 §10.4) — the account
 * profile adapter for the repository Fake Agent, registered only on the
 * development/test assembly path (compose `includeDevelopmentAgents`). Without
 * it a Fake Agent Run pinned to an account profile cannot start (AgentManager
 * rejects profile projection with no adapter) and `account.detect` cannot
 * probe the profile — which is exactly what the TASK-115 E2E exercises.
 *
 * "Account = environment" for the Fake Agent is a single `FAKE_HOME` variable
 * carrying the profile's configHome verbatim (mirroring §10.1 step 1); the
 * Fake Agent itself never reads it. Status detection is deterministic — a
 * profile with a configHome is `ready` — and the "login" command is a
 * no-success-op (`node --version`), so the §24 Login Terminal flow ends in a
 * verified `ready` state without any real auth material.
 */

export const FAKE_HOME_ENV_KEY = 'FAKE_HOME'

function missingConfigHome(operation: string): IpcResult<never> {
  return {
    ok: false,
    error: toPublicError({
      code: 'VALIDATION_FAILED',
      message: 'The Fake Agent account profile has no configHome and cannot be projected.',
      retryable: false,
      detail: `${operation}: profile without configHome (managed profiles always carry one, §5.3)`,
    }),
  }
}

export function createFakeAccountProfileAdapter(): AgentAccountProfileAdapter {
  return {
    agentId: FAKE_AGENT.id,
    reservedEnvKeys: [FAKE_HOME_ENV_KEY],

    buildRuntimeProjection(profile): IpcResult<AccountProfileRuntimeProjection> {
      if (profile.agentId !== FAKE_AGENT.id) {
        return {
          ok: false,
          error: toPublicError({
            code: 'VALIDATION_FAILED',
            message: `The account profile belongs to agent "${profile.agentId}", not the Fake Agent.`,
            retryable: false,
            detail: `FakeAccountProfileAdapter received profile ${profile.id} agentId=${profile.agentId}`,
          }),
        }
      }
      if (profile.configHome === undefined) {
        return missingConfigHome('buildRuntimeProjection')
      }
      return { ok: true, data: { env: { [FAKE_HOME_ENV_KEY]: profile.configHome } } }
    },

    detectStatus(profile: AgentAccountProfile): Promise<IpcResult<AccountProfileStatusDetection>> {
      return Promise.resolve({
        ok: true,
        data: { status: profile.configHome === undefined ? 'unknown' : 'ready' },
      })
    },

    buildLoginCommand(profile): IpcResult<AccountProfileLoginCommand> {
      if (profile.configHome === undefined) {
        return missingConfigHome('buildLoginCommand')
      }
      // argv only — the double has no auth flow, so a version probe stands in
      // for "login" and exits 0 immediately.
      return {
        ok: true,
        data: { command: FAKE_AGENT.executable.command, args: ['--version'] },
      }
    },
  }
}
