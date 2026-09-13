import type {
  AgentAccountProfile,
  AgentResumeProfileContext,
  AgentRun,
  IpcResult,
  WorkspaceRuntimeRef,
} from '@teskra/contracts'

import { toPublicError } from '../../errors'
import type { WorkspaceRuntime } from '../../workspace/runtime'
import type { AgentAccountProfileAdapter } from './account-profile-adapter'

/**
 * §38/§39 historical Runtime Identity (TASK-100/112).
 *
 * Resume and crash recovery must restore a Run with the identity it was
 * STARTED with — never with whatever the current agent default happens to be.
 * The run row is the source of truth: `accountProfileId` +
 * `profileSnapshot.configHome`. The profile row is read only to detect
 * identity drift (§10.5); a disabled or even deleted profile row does NOT
 * block restoration — the snapshot is the truth and projecting it is exactly
 * "restore with the historical identity". Only when neither the snapshot nor
 * the row can name a configHome is restoration impossible, and that is an
 * explicit error rather than a silent account switch.
 */

export interface HistoricalProfileProjection {
  /** The profile env to apply in the launch slot (§13.1). */
  readonly env: Record<string, string>
  /** The configHome the process will actually run against. */
  readonly configHome: string
  /** §10.5 resume-validation context for the CLI adapter. */
  readonly resumeProfileContext: AgentResumeProfileContext
}

export interface ProjectHistoricalProfileIdentityOptions {
  readonly run: Pick<AgentRun, 'id' | 'agentType' | 'accountProfileId' | 'profileSnapshot'>
  /** The current profile row — may be disabled, or null when deleted (§38). */
  readonly profile: AgentAccountProfile | null
  readonly adapter: AgentAccountProfileAdapter
  readonly runtime: WorkspaceRuntime
  /** Fallback runtime ref when the snapshot predates the runtime field. */
  readonly workspaceRuntime: WorkspaceRuntimeRef
}

export function projectHistoricalProfileIdentity(
  options: ProjectHistoricalProfileIdentityOptions,
): IpcResult<HistoricalProfileProjection> {
  const { run, profile, adapter, runtime, workspaceRuntime } = options
  if (run.accountProfileId === undefined) {
    return {
      ok: false,
      error: toPublicError({
        code: 'VALIDATION_FAILED',
        message: 'The run has no account profile identity to restore.',
        retryable: false,
        detail: `run ${run.id} has no accountProfileId`,
      }),
    }
  }

  const snapshotConfigHome = run.profileSnapshot?.configHome
  const configHome = snapshotConfigHome ?? profile?.configHome
  if (configHome === undefined) {
    return {
      ok: false,
      error: toPublicError({
        code: 'ACCOUNT_PROFILE_NOT_FOUND',
        message:
          'The account profile this run used no longer exists and the run snapshot has no config home. The run cannot be restored without switching accounts — start a Continuation run with a different account instead.',
        retryable: false,
        detail: `run ${run.id} profile ${run.accountProfileId} deleted and snapshot carries no configHome`,
      }),
    }
  }

  // A deleted row restores by snapshot (the snapshot is the truth); with the
  // row present its configHome is the current resolution (§10.5 drift check).
  const currentConfigHome = profile?.configHome ?? snapshotConfigHome

  const profileForProjection: AgentAccountProfile = profile ??
    // The row is gone: synthesize the minimal projection input from the
    // snapshot. Adapters read only agentId/configHome (auth material is
    // never consulted for projection), so the placeholder fields are inert.
    {
      id: run.accountProfileId,
      agentId: run.agentType,
      name: run.profileSnapshot?.accountProfileName ?? run.accountProfileId,
      authType: 'external',
      runtime: run.profileSnapshot?.runtime ?? workspaceRuntime,
      configHome,
      status: 'unknown',
      enabled: false,
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
    }

  const projection = adapter.buildRuntimeProjection(profileForProjection, runtime)
  if (!projection.ok) {
    return projection
  }
  return {
    ok: true,
    data: {
      env: { ...projection.data.env },
      configHome,
      resumeProfileContext: {
        accountProfileId: run.accountProfileId,
        ...(snapshotConfigHome === undefined ? {} : { snapshotConfigHome }),
        ...(currentConfigHome === undefined ? {} : { currentConfigHome }),
      },
    },
  }
}
