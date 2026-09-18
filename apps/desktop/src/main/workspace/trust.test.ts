import { describe, expect, it } from 'vitest'

import { repoLocalContentAllowed, trustedRepoRoot } from './trust'

/**
 * TASK-118: the single decision point for repo-local content loading. Only an
 * explicitly trusted workspace may expose its repo root to the workflow /
 * prompt / config loaders.
 */
describe('workspace trust helpers (TASK-118)', () => {
  it('allows repo-local content only for trusted workspaces', () => {
    expect(repoLocalContentAllowed({ trustLevel: 'trusted' })).toBe(true)
    expect(repoLocalContentAllowed({ trustLevel: 'restricted' })).toBe(false)
  })

  it('hands the repo root to loaders only when trusted', () => {
    expect(trustedRepoRoot({ trustLevel: 'trusted', path: '/repo' })).toBe('/repo')
    expect(trustedRepoRoot({ trustLevel: 'restricted', path: '/repo' })).toBeUndefined()
  })
})
