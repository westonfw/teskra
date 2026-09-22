import type { FullWorkflowLaunchDefaults, StartFullWorkflowRequest } from '@teskra/contracts'

/**
 * TASK-137 (Milestone 26 §10) — the two-state launch dialog model of the
 * default full workflow, kept pure so the summary / toggle / request-building
 * logic is unit-testable without a DOM:
 *
 * - 'summary' (default): a one-line summary of the resolved defaults with a
 *   single Start action; 'edit' expands the original three optional overrides.
 * - The summary is display-only — a no-input launch sends NO override fields,
 *   so Main keeps resolving them (and a repo-defined test command keeps its
 *   requireConfirmation marking, TASK-118).
 */

export type WorkflowLaunchMode = 'summary' | 'edit'

export interface WorkflowLaunchDialogState {
  readonly mode: WorkflowLaunchMode
  /** Explicit overrides; empty means "resolve server-side". */
  readonly implementer: string | undefined
  readonly reviewers: readonly string[]
  readonly testCommand: string
}

/** Fresh dialog state: the default state is the summary, not the form. */
export function openWorkflowLaunchDialog(): WorkflowLaunchDialogState {
  return { mode: 'summary', implementer: undefined, reviewers: [], testCommand: '' }
}

export function showLaunchEditor(state: WorkflowLaunchDialogState): WorkflowLaunchDialogState {
  return { ...state, mode: 'edit' }
}

export function showLaunchSummary(state: WorkflowLaunchDialogState): WorkflowLaunchDialogState {
  return { ...state, mode: 'summary' }
}

export interface WorkflowLaunchSummary {
  readonly implementer: string
  /** Joined reviewer ids; undefined when the resolution found none. */
  readonly reviewersText: string | undefined
  readonly testCommand: string
  /** true = the command came from the repo `full` definition (needs confirmation). */
  readonly testCommandFromRepo: boolean
}

/** View model of the one-line summary, straight from the resolved defaults. */
export function launchSummaryModel(defaults: FullWorkflowLaunchDefaults): WorkflowLaunchSummary {
  return {
    implementer: defaults.implementer,
    reviewersText: defaults.reviewers.length === 0 ? undefined : defaults.reviewers.join(', '),
    testCommand: defaults.testCommand,
    testCommandFromRepo: defaults.testCommandFromRepo,
  }
}

/**
 * Builds the launch request from the dialog fields; every field left empty is
 * OMITTED (never sent as an empty value) so a no-input start resolves fully
 * server-side — same optionality as the contract.
 */
export function buildFullWorkflowStartRequest(input: {
  readonly workspaceId: string
  readonly taskId: string
  readonly implementer: string | undefined
  readonly reviewers: readonly string[]
  readonly testCommand: string
}): StartFullWorkflowRequest {
  const testCommand = input.testCommand.trim()
  return {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    ...(input.implementer === undefined ? {} : { implementer: input.implementer }),
    ...(input.reviewers.length === 0 ? {} : { reviewers: [...input.reviewers] }),
    ...(testCommand === '' ? {} : { testCommand }),
  }
}
