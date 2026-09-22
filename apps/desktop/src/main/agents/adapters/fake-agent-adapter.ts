import type { AgentStartRequest } from '@teskra/contracts'

import { FAKE_AGENT } from '../definitions/fake'
import { createCliAgentAdapter, type CliAgentAdapterOptions } from './cli-agent-adapter'
import type { CodingAgentAdapter } from './coding-agent-adapter'

export interface FakeAgentAdapterOptions extends Omit<
  CliAgentAdapterOptions,
  'definition' | 'baseArgs' | 'buildLaunch'
> {
  readonly scriptPath: string
}

function fakeScenario(request: AgentStartRequest): string {
  return request.environment?.['TESKRA_FAKE_SCENARIO'] ?? 'success'
}

export function createFakeAgentAdapter(options: FakeAgentAdapterOptions): CodingAgentAdapter {
  return createCliAgentAdapter({
    ...options,
    definition: FAKE_AGENT,
    baseArgs: [options.scriptPath],
    // A session-less provider reference (the kimi-adapter pattern): it lets
    // the TASK-139 thread continuation gate engage end-to-end — the second
    // message reuses the source run's worktree with the Handoff-backed
    // continuation prompt (capabilities.resume stays false, so AgentManager
    // logs the no-native-resume fallback instead of calling adapter.resume).
    buildLaunch: (request) => ({
      args: ['--scenario', fakeScenario(request)],
      providerSession: { provider: FAKE_AGENT.id },
    }),
  })
}
