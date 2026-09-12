import { describe, expect, it } from 'vitest'

import {
  MAX_RENDERED_PATCH_CHARS,
  MAX_VISIBLE_CHANGE_FILES,
  filesForDisplay,
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
})
