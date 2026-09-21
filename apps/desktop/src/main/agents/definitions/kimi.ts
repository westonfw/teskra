import type { AgentDefinition } from '@teskra/contracts'

/**
 * Kimi Code CLI (`kimi`) — see the kimi-code-cli reference docs:
 * - `--version` prints the version; `--prompt <prompt>` runs one prompt
 *   non-interactively (print mode); `--session [id]` / `--continue` resume.
 * - Permission modes are launch flags: `--plan` (read-only planning),
 *   `--yolo` (Ask When Needed), `--auto` (Never Ask); the Always-Ask
 *   default needs no flag. The flags are rejected in combination with
 *   `--prompt` (non-interactive runs always use the CLI's own auto policy),
 *   so the Adapter only emits them for interactive launches.
 * - There is no documented positional-prompt form for the interactive TUI,
 *   so an initial prompt can only be transmitted in `--prompt` mode.
 */
export const KIMI_AGENT: AgentDefinition = {
  id: 'kimi',
  name: 'Kimi Code',
  executable: { command: 'kimi' },
  capabilities: {
    interactive: true,
    headless: true,
    resume: true,
    readOnlyMode: true,
    modelSelection: true,
  },
  prompt: {
    interactiveArgs: [],
    headlessArgs: ['--prompt'],
  },
  detection: { versionArgs: ['--version'] },
  defaults: { role: 'implementer', permissionProfile: 'safe-auto' },
  permissionEnforcement: 'native',
  // TASK-122 (§6.1): no structured-output protocol family yet.
  output: { structured: 'none' },
  routing: {
    agentId: 'kimi',
    useWhen: 'Implementation, refactoring, and autonomous coding loops with Kimi models.',
    strengths: ['implementation', 'refactoring', 'autonomous-loop'],
    costClass: 'medium',
    priority: 80,
  },
}
