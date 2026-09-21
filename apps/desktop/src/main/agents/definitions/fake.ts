import type { AgentDefinition } from '@teskra/contracts'

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
  // TASK-122 (§6.1): raw output; the `structured-stream` fake scenario is TASK-123 scope.
  output: { structured: 'none' },
  routing: {
    agentId: 'fake',
    useWhen: 'Deterministic development, CI, and failure-path testing.',
    strengths: ['testing', 'simulation'],
    costClass: 'low',
    priority: 10,
  },
}
