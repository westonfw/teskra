import { afterEach, describe, expect, it, vi } from 'vitest'

import { AGENT_OUTPUT_BATCH_MS, createAgentOutputBatcher } from './agent-output-batcher'

afterEach(() => vi.useRealTimers())

describe('Agent output batcher', () => {
  it('coalesces character-level output inside a 16–50ms window', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const batcher = createAgentOutputBatcher(publish)

    for (const character of 'raw PTY output') batcher.push('run-1', character)
    vi.advanceTimersByTime(AGENT_OUTPUT_BATCH_MS - 1)
    expect(publish).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(AGENT_OUTPUT_BATCH_MS).toBeGreaterThanOrEqual(16)
    expect(AGENT_OUTPUT_BATCH_MS).toBeLessThanOrEqual(50)
    expect(publish).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledWith('run-1', 'raw PTY output')
  })

  it('coalesces a 10 MiB stream without producing per-chunk publishes', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const batcher = createAgentOutputBatcher(publish)
    const chunk = 'x'.repeat(10 * 1024)

    for (let index = 0; index < 1024; index += 1) batcher.push('run-large', chunk)
    vi.advanceTimersByTime(AGENT_OUTPUT_BATCH_MS)

    expect(publish).toHaveBeenCalledOnce()
    expect((publish.mock.calls[0]?.[1] as string).length).toBe(10 * 1024 * 1024)
  })

  it('flushes each Run independently before exit or disposal', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const batcher = createAgentOutputBatcher(publish)
    batcher.push('run-1', 'one')
    batcher.push('run-2', 'two')

    batcher.flush('run-1')
    expect(publish).toHaveBeenCalledWith('run-1', 'one')
    expect(publish).not.toHaveBeenCalledWith('run-2', 'two')
    batcher.flushAll()
    expect(publish).toHaveBeenCalledWith('run-2', 'two')
  })
})
