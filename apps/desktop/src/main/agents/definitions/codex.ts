import type { AgentDefinition } from '@teskra/contracts'

export const CODEX_AGENT: AgentDefinition = {
  id: 'codex',
  name: 'Codex',
  executable: { command: 'codex' },
  capabilities: {
    interactive: true,
    headless: true,
    resume: true,
    // Deliberately false: Codex's `--sandbox read-only` cannot write ANY file,
    // so a read-only reviewer could never write its handoff (ADR-0004) —
    // observed on a real run where both apply_patch and direct writes were
    // denied, and the CLI offers no writable-root grant under read-only.
    // ReviewerService therefore isolates Codex reviews with the
    // disposable-snapshot tier instead (ADR-0002 environmental boundary).
    readOnlyMode: false,
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
  // TASK-122 (§6.1): `--json` lands after the `exec` subcommand, before the prompt.
  output: {
    structured: 'codex-exec-json',
    structuredArgs: ['--json'],
  },
  routing: {
    agentId: 'codex',
    useWhen: 'Implementation, refactoring, and autonomous coding loops.',
    strengths: ['implementation', 'refactoring', 'autonomous-loop'],
    costClass: 'medium',
    priority: 100,
  },
}
