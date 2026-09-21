import { describe, expect, it } from 'vitest'

import { createLineSplitter, OBSERVATION_MAX_LINE_CHARS } from './line-splitter'

describe('LineSplitter (TASK-123 §6.2)', () => {
  it('splits complete lines on \\n', () => {
    const splitter = createLineSplitter()
    expect(splitter.push('one\ntwo\nthree\n')).toEqual(['one', 'two', 'three'])
    expect(splitter.flush()).toBeUndefined()
  })

  it('strips \\r (CRLF writers and bare carriage returns)', () => {
    const splitter = createLineSplitter()
    expect(splitter.push('one\r\ntwo\r\n')).toEqual(['one', 'two'])
    expect(splitter.push('thr\ree\n')).toEqual(['three'])
  })

  it('holds an incomplete tail line across chunks', () => {
    const splitter = createLineSplitter()
    expect(splitter.push('{"type":"sys')).toEqual([])
    expect(splitter.push('tem","subtype":"init"}\nnext')).toEqual([
      '{"type":"system","subtype":"init"}',
    ])
    expect(splitter.flush()).toBe('next')
    expect(splitter.flush()).toBeUndefined()
  })

  it('handles empty chunks and empty lines', () => {
    const splitter = createLineSplitter()
    expect(splitter.push('')).toEqual([])
    expect(splitter.push('\n\n')).toEqual(['', ''])
  })

  it('keeps a line at exactly the 64 KiB ceiling', () => {
    const splitter = createLineSplitter()
    const line = 'x'.repeat(OBSERVATION_MAX_LINE_CHARS)
    expect(splitter.push(`${line}\n`)).toEqual([line])
    expect(splitter.droppedLines).toBe(0)
  })

  it('drops and counts a line beyond 64 KiB (single chunk)', () => {
    const splitter = createLineSplitter()
    const over = 'x'.repeat(OBSERVATION_MAX_LINE_CHARS + 1)
    expect(splitter.push(`${over}\nok\n`)).toEqual(['ok'])
    expect(splitter.droppedLines).toBe(1)
  })

  it('drops and counts an over-long line that spans multiple chunks', () => {
    const splitter = createLineSplitter()
    expect(splitter.push('x'.repeat(OBSERVATION_MAX_LINE_CHARS))).toEqual([])
    // Exceed the ceiling mid-line without a newline: enter discard mode.
    expect(splitter.push('more-bytes')).toEqual([])
    expect(splitter.droppedLines).toBe(1)
    // Discard mode lasts until the giant line's terminating newline.
    expect(splitter.push('even-more')).toEqual([])
    expect(splitter.push('tail\nnext\n')).toEqual(['next'])
    expect(splitter.droppedLines).toBe(1)
  })

  it('drops an over-long unterminated tail at flush', () => {
    const splitter = createLineSplitter()
    splitter.push('x'.repeat(OBSERVATION_MAX_LINE_CHARS + 1))
    expect(splitter.flush()).toBeUndefined()
    // The line already counted when it crossed the ceiling in push().
    expect(splitter.droppedLines).toBe(1)
  })

  it('survives several oversized lines in a row', () => {
    const splitter = createLineSplitter()
    const over = 'x'.repeat(OBSERVATION_MAX_LINE_CHARS + 10)
    expect(splitter.push(`${over}\n${over}\nsmall\n`)).toEqual(['small'])
    expect(splitter.droppedLines).toBe(2)
  })
})
