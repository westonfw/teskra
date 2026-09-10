export const AGENT_OUTPUT_BATCH_MS = 32

export interface AgentOutputBatcher {
  push(runId: string, data: string): void
  flush(runId: string): void
  flushAll(): void
}

/** Coalesces bursty PTY fragments into one event/DB write per animation-scale window. */
export function createAgentOutputBatcher(
  publish: (runId: string, data: string) => void,
  delayMs = AGENT_OUTPUT_BATCH_MS,
): AgentOutputBatcher {
  const buffers = new Map<string, string[]>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const flush = (runId: string): void => {
    const timer = timers.get(runId)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(runId)
    const chunks = buffers.get(runId)
    buffers.delete(runId)
    if (chunks === undefined || chunks.length === 0) return
    publish(runId, chunks.join(''))
  }

  return {
    push(runId, data) {
      if (data.length === 0) return
      const chunks = buffers.get(runId)
      if (chunks === undefined) {
        buffers.set(runId, [data])
        timers.set(
          runId,
          setTimeout(() => flush(runId), delayMs),
        )
      } else {
        chunks.push(data)
      }
    },
    flush,
    flushAll() {
      for (const runId of [...buffers.keys()]) flush(runId)
    },
  }
}
