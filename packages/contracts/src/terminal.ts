import { z } from 'zod'

/** plan §11 — TerminalSession ≠ AgentRun. */
export const TERMINAL_SHELLS = ['powershell', 'cmd', 'wsl', 'bash'] as const
export const terminalShellSchema = z.enum(TERMINAL_SHELLS)
export type TerminalShell = z.infer<typeof terminalShellSchema>

export const terminalSessionSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  shell: terminalShellSchema,
  /** Runtime ProcessManager id. */
  processId: z.string(),
  title: z.string(),
  /** ISO-8601 UTC. */
  createdAt: z.string(),
})
export type TerminalSession = z.infer<typeof terminalSessionSchema>
