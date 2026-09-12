import type { AgentDefinition } from '@teskra/contracts'

export const CLAUDE_AGENT: AgentDefinition = {
  id: 'claude',
  name: 'Claude Code',
  executable: { command: 'claude' },
  capabilities: {
    interactive: true,
    headless: true,
    resume: true,
    readOnlyMode: true,
    modelSelection: true,
  },
  prompt: {
    interactiveArgs: [],
    headlessArgs: ['--print'],
  },
  detection: { versionArgs: ['--version'] },
  defaults: { role: 'reviewer', permissionProfile: 'manual' },
  permissionEnforcement: 'native',
  /**
   * P1-4: Claude Code prints completed tool calls into the scrollback as
   * transcript lines like `⏺ Bash(npm test)` (older builds use `●`). Only
   * single-line Bash invocations are recognized; multi-line commands render
   * with a `…` continuation and are conservatively missed.
   */
  auditCommandPatterns: [{ pattern: '^\\s*[⏺●]\\s+Bash\\((.+)\\)\\s*$' }],
  routing: {
    agentId: 'claude',
    useWhen: 'Architecture, review, and work requiring broad context.',
    strengths: ['review', 'architecture', 'long-context'],
    costClass: 'medium',
    priority: 90,
  },
}
