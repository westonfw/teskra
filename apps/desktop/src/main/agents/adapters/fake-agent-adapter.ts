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
    buildLaunch: (request) => ({ args: ['--scenario', fakeScenario(request)] }),
  })
}
