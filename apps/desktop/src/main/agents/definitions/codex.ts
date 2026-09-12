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
  /**
   * P1-4: `codex exec` prints a bare `exec` marker line, then
   * `<command> in <cwd>` (see codex-rs exec event_processor_with_human_output).
   * The greedy prefix keeps everything up to the LAST ` in `, so commands that
   * themselves contain " in " still split at the cwd boundary. The interactive
   * full-screen TUI redraws its viewport and is NOT reliably recognized — see
   * the audit coverage note in ADR-0002.
   */
  auditCommandPatterns: [{ pattern: '^(.+) in .+$', afterMarker: '^exec$' }],
  routing: {
    agentId: 'codex',
    useWhen: 'Implementation, refactoring, and autonomous coding loops.',
    strengths: ['implementation', 'refactoring', 'autonomous-loop'],
    costClass: 'medium',
    priority: 100,
  },
}
