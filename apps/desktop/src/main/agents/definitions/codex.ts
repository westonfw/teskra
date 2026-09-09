import type { AgentDefinition } from '@teskra/contracts'

export const CODEX_AGENT: AgentDefinition = {
  id: 'codex',
  name: 'Codex',
  executable: { command: 'codex' },
  capabilities: {
    interactive: true,
    headless: true,
    resume: true,
    readOnlyMode: true,
    modelSelection: true,
  },
  prompt: {
    interactiveArgs: [],
    headlessArgs: ['exec'],
  },
  detection: { versionArgs: ['--version'] },
  defaults: { role: 'implementer', permissionProfile: 'safe-auto' },
  permissionEnforcement: 'config',
  routing: {
    agentId: 'codex',
    useWhen: 'Implementation, refactoring, and autonomous coding loops.',
    strengths: ['implementation', 'refactoring', 'autonomous-loop'],
    costClass: 'medium',
    priority: 100,
  },
}
