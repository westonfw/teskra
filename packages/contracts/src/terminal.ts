import { z } from 'zod'

import { ipcIdSchema, ipcNameSchema, ipcContentSchema, terminalDimensionSchema } from './limits'

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
  workspaceId: ipcIdSchema,
  shell: terminalShellSchema,
  title: ipcNameSchema.optional(),
  cols: terminalDimensionSchema.optional(),
  rows: terminalDimensionSchema.optional(),
})
export type CreateTerminalRequest = z.infer<typeof createTerminalRequestSchema>

export const terminalWriteRequestSchema = z.strictObject({
  terminalId: ipcIdSchema,
  data: ipcContentSchema,
})
export type TerminalWriteRequest = z.infer<typeof terminalWriteRequestSchema>

export const terminalResizeRequestSchema = z.strictObject({
  terminalId: ipcIdSchema,
  cols: terminalDimensionSchema,
  rows: terminalDimensionSchema,
})
export type TerminalResizeRequest = z.infer<typeof terminalResizeRequestSchema>

export const terminalCloseRequestSchema = z.strictObject({
  terminalId: ipcIdSchema,
})
export type TerminalCloseRequest = z.infer<typeof terminalCloseRequestSchema>

export const terminalIdRequestSchema = terminalCloseRequestSchema
export type TerminalIdRequest = TerminalCloseRequest

export const listTerminalsRequestSchema = z.strictObject({
  workspaceId: ipcIdSchema.optional(),
})
export type ListTerminalsRequest = z.infer<typeof listTerminalsRequestSchema>
