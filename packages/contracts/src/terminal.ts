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

export const createTerminalRequestSchema = z.strictObject({
  workspaceId: z.string().min(1),
  shell: terminalShellSchema,
  title: z.string().min(1).optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
})
export type CreateTerminalRequest = z.infer<typeof createTerminalRequestSchema>

export const terminalWriteRequestSchema = z.strictObject({
  terminalId: z.string().min(1),
  data: z.string(),
})
export type TerminalWriteRequest = z.infer<typeof terminalWriteRequestSchema>

export const terminalResizeRequestSchema = z.strictObject({
  terminalId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
})
export type TerminalResizeRequest = z.infer<typeof terminalResizeRequestSchema>

export const terminalCloseRequestSchema = z.strictObject({
  terminalId: z.string().min(1),
})
export type TerminalCloseRequest = z.infer<typeof terminalCloseRequestSchema>

export const terminalIdRequestSchema = terminalCloseRequestSchema
export type TerminalIdRequest = TerminalCloseRequest

export const listTerminalsRequestSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
})
export type ListTerminalsRequest = z.infer<typeof listTerminalsRequestSchema>
