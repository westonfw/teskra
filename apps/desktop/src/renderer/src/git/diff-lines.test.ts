import { describe, expect, it } from 'vitest'

import { classifyDiffLine, splitDiffLines } from './diff-lines'

describe('classifyDiffLine', () => {
  it('classifies added and removed content lines', () => {
    expect(classifyDiffLine('+const a = 1')).toBe('add')
    expect(classifyDiffLine('-const a = 1')).toBe('del')
  })

  it('treats file headers as meta, not add/del content', () => {
    expect(classifyDiffLine('+++ b/main.cpp')).toBe('meta')
    expect(classifyDiffLine('--- a/main.cpp')).toBe('meta')
    expect(classifyDiffLine('--- /dev/null')).toBe('meta')
  })

  it('treats hunk headers and diff preamble as meta', () => {
    expect(classifyDiffLine('@@ -1 +1,2 @@')).toBe('hunk')
    expect(classifyDiffLine('diff --git a/x b/x')).toBe('meta')
    expect(classifyDiffLine('index ce01362..33dc223 100644')).toBe('meta')
    expect(classifyDiffLine('new file mode 100644')).toBe('meta')
    expect(classifyDiffLine('\\ No newline at end of file')).toBe('meta')
  })

  it('treats everything else as context, including +-like content mid-line', () => {
    expect(classifyDiffLine(' hello')).toBe('context')
    expect(classifyDiffLine('')).toBe('context')
    expect(classifyDiffLine('a + b - c')).toBe('context')
  })
})

describe('splitDiffLines', () => {
  it('drops the phantom trailing line produced by the final newline', () => {
    const lines = splitDiffLines('@@ -0,0 +1 @@\n+hello\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toEqual({ text: '+hello', kind: 'add' })
  })

  it('keeps empty context lines inside the patch', () => {
    const lines = splitDiffLines('@@ -1,2 +1,2 @@\n hello\n \n')
    expect(lines).toHaveLength(3)
    expect(lines[2]).toEqual({ text: ' ', kind: 'context' })
  })
})
