import type { Workspace } from '@teskra/contracts'

/**
 * TASK-118 Workspace Trust helpers (design doc §43, code-review P0-3).
 *
 * Repo-local content — the workflows / prompts / config files under the
 * repository's Teskra directory — is controlled by the repository author and
 * can carry executable commands, so it only loads for workspaces the user
 * explicitly trusted. Everything else stays restricted (the migration 015
 * default). This module is the single decision point; call sites pass the
 * repo root to loaders only when this returns true.
 */

/** true when the workspace may load repo-local workflows / prompts / config. */
export function repoLocalContentAllowed(workspace: Pick<Workspace, 'trustLevel'>): boolean {
  return workspace.trustLevel === 'trusted'
}

/**
 * The repo root to hand a repo-local loader, or undefined when the workspace
 * is restricted (loaders then serve built-in / global content only).
 */
export function trustedRepoRoot(
  workspace: Pick<Workspace, 'trustLevel' | 'path'>,
): string | undefined {
  return repoLocalContentAllowed(workspace) ? workspace.path : undefined
}
