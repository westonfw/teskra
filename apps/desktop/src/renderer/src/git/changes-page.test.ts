import { describe, expect, it } from 'vitest'

import { MAX_RENDERED_PATCH_CHARS, patchForDisplay } from './changes-page'

describe('Changes page (TASK-037)', () => {
  it('bounds large patches before rendering them into the DOM', () => {
    const patch = 'x'.repeat(MAX_RENDERED_PATCH_CHARS + 50_000)

    expect(patchForDisplay(patch)).toEqual({
      text: 'x'.repeat(MAX_RENDERED_PATCH_CHARS),
      truncated: true,
    })
  })
})
