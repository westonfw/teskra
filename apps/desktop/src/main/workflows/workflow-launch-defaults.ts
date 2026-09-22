import type { FullWorkflowLaunchDefaults, IpcResult } from '@teskra/contracts'

import type { DefaultSelectionService } from '../agents/default-selection-service'
import type { WorkspaceRepository } from '../db/repositories/workspace-repository'
import { type InternalAppError, toPublicError } from '../errors'
import { repoLocalContentAllowed } from '../workspace/trust'
import {
  DEFAULT_FULL_TEST_COMMAND,
  DEFAULT_FULL_WORKFLOW_ID,
  extractFullWorkflowConfig,
} from './default-workflow'
import type { WorkflowDefinitionLoader } from './definition-loader'

/**
 * WorkflowLaunchDefaultsService (TASK-137, Milestone 26 §10) — the default-state
 * summary of the full-workflow launch dialog: what a no-input start would run
 * with. `implementer` / `reviewers` come from the DefaultSelectionService
 * (TASK-134); `testCommand` comes from the repo-local `full` definition — but
 * only for a trusted workspace (TASK-118: repo-controlled content never loads
 * for a restricted one), otherwise the built-in default.
 *
 * Display-only: the launch itself still resolves every omitted field in
 * FullWorkflowService, so a repo-defined test command keeps its
 * requireConfirmation marking there — the dialog never sends the displayed
 * command back as a request override.
 */

export interface WorkflowLaunchDefaultsService {
  resolve(workspaceId: string): Promise<IpcResult<FullWorkflowLaunchDefaults>>
}

export interface WorkflowLaunchDefaultsServiceDeps {
  readonly workspaces: Pick<WorkspaceRepository, 'getById'>
  readonly definitions: Pick<WorkflowDefinitionLoader, 'list'>
  readonly defaults: Pick<DefaultSelectionService, 'resolveWorkflowDefaults'>
}

function fail<T>(error: InternalAppError): IpcResult<T> {
  return { ok: false, error: toPublicError(error) }
}

function invalid<T>(
  message: string,
  detail: string,
  messageKey?: string,
  params?: Record<string, string | number>,
): IpcResult<T> {
  return fail({
    code: 'VALIDATION_FAILED',
    message,
    ...(messageKey === undefined ? {} : { messageKey }),
    ...(params === undefined ? {} : { params }),
    retryable: false,
    detail,
  })
}

export function createWorkflowLaunchDefaultsService(
  deps: WorkflowLaunchDefaultsServiceDeps,
): WorkflowLaunchDefaultsService {
  return {
    async resolve(workspaceId) {
      const workspace = deps.workspaces.getById(workspaceId)
      if (!workspace.ok) return workspace
      if (workspace.data === null) {
        return invalid(
          `Workspace "${workspaceId}" was not found.`,
          `WorkflowLaunchDefaultsService could not resolve workspace id=${JSON.stringify(workspaceId)}`,
          'errorMessage.workspaceNotFound',
        )
      }

      const defaults = await deps.defaults.resolveWorkflowDefaults(workspaceId)
      if (!defaults.ok) return defaults

      let testCommand = DEFAULT_FULL_TEST_COMMAND
      let testCommandFromRepo = false
      // TASK-118: the repo-local definition is repo-controlled content — it is
      // read only for a trusted workspace, exactly like the launch path.
      if (repoLocalContentAllowed(workspace.data)) {
        const listed = deps.definitions.list(workspace.data.path)
        if (!listed.ok) return listed
        const override = listed.data.find((info) => info.id === DEFAULT_FULL_WORKFLOW_ID)
        if (override !== undefined) {
          if (override.status === 'invalid' || override.definition === undefined) {
            return invalid(
              `Workflow definition "${DEFAULT_FULL_WORKFLOW_ID}" is invalid and cannot drive the default full workflow.`,
              `${override.path}: ${override.issues.join('; ')}`,
              'errorMessage.fullWorkflowOverrideInvalid',
              { id: DEFAULT_FULL_WORKFLOW_ID },
            )
          }
          const config = extractFullWorkflowConfig(override.definition)
          if (!config.ok) return config
          testCommand = config.data.testCommand
          testCommandFromRepo = true
        }
      }

      return {
        ok: true,
        data: {
          implementer: defaults.data.implementer.agentType,
          reviewers: [...defaults.data.reviewers],
          testCommand,
          testCommandFromRepo,
        },
      }
    },
  }
}
