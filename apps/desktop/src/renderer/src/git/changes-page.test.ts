import { describe, expect, it } from 'vitest'

import {
  MAX_RENDERED_PATCH_CHARS,
  MAX_VISIBLE_CHANGE_FILES,
  filesForDisplay,
  isNotARepositoryError,
  patchForDisplay,
} from './changes-page'

describe('Changes page (TASK-037)', () => {
  it('bounds large patches before rendering them into the DOM', () => {
    const patch = 'x'.repeat(MAX_RENDERED_PATCH_CHARS + 50_000)

    expect(patchForDisplay(patch)).toEqual({
      text: 'x'.repeat(MAX_RENDERED_PATCH_CHARS),
      truncated: true,
    })
  })

  it('bounds the rendered list for repositories with more than 10k changes', () => {
    const files = Array.from({ length: 10_001 }, (_, index) => ({
      path: `generated/file-${String(index)}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 0,
    }))

    expect(filesForDisplay(files)).toHaveLength(MAX_VISIBLE_CHANGE_FILES)
    expect(filesForDisplay(files).at(-1)?.path).toBe('generated/file-499.ts')
  })

  it('routes only GIT_NOT_A_REPOSITORY to the guided empty state', () => {
    expect(
      isNotARepositoryError({
        code: 'GIT_NOT_A_REPOSITORY',
        message: 'This directory is not a Git repository yet.',
        retryable: false,
      }),
    ).toBe(true)
    expect(
      isNotARepositoryError({ code: 'UNKNOWN', message: 'Git status failed.', retryable: true }),
    ).toBe(false)
    expect(isNotARepositoryError(undefined)).toBe(false)
  })
})
