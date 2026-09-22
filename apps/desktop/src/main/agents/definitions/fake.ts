import type { AgentDefinition } from '@teskra/contracts'

/**
 * TASK-122 (§6.1): the shipped Fake Agent emits raw output. TASK-125 E2E:
 * TESKRA_FAKE_AGENT_STRUCTURED=1 opts it into the claude-stream-json family so
 * the `structured-stream` scenario exercises the observation pipeline through
 * the real launch path (the AgentRegistry reads this same definition).
 * `structuredArgs` stays empty — the scenario already emits NDJSON on stdout.
 */
function fakeOutput(): AgentDefinition['output'] {
  if (process.env['TESKRA_FAKE_AGENT_STRUCTURED'] !== '1') return { structured: 'none' }
  return { structured: 'claude-stream-json', structuredArgs: [] }
}

export const FAKE_AGENT: AgentDefinition = {
  id: 'fake',
  name: 'Fake Agent',
  executable: { command: 'node', defaultArgs: ['tools/fake-agent.js'] },
  capabilities: {
    interactive: true,
    headless: true,
    resume: false,
    readOnlyMode: false,
    modelSelection: false,
  },
  prompt: {},
  detection: { versionArgs: ['--version'] },
  defaults: { role: 'tester', permissionProfile: 'isolated' },
  permissionEnforcement: 'none',
  output: fakeOutput(),
  routing: {
    agentId: 'fake',
    useWhen: 'Deterministic development, CI, and failure-path testing.',
    strengths: ['testing', 'simulation'],
    costClass: 'low',
    priority: 10,
  },
}
