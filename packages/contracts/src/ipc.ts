import { z } from 'zod'

/**
 * Typed IPC channel registry (TASK-003). This stage defines only the channel
 * name constants, the envelope (`IpcResult`, see error.ts) and the existing
 * `teskra:ping` channel as the reference example. TASK-020 extends
 * `ipcChannelDefinitions` incrementally — one entry per channel, each with a
 * Zod request schema (and response schema where the channel returns data).
 */
export const IPC_CHANNELS = {
  ping: 'teskra:ping',
} as const
export type IpcChannelName = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

export interface IpcChannelDefinition<Req, Res> {
  readonly channel: IpcChannelName
  readonly request: z.ZodType<Req>
  readonly response: z.ZodType<Res>
}

export const pingRequestSchema = z.void()
export const pingResponseSchema = z.string()

export const pingChannel = {
  channel: IPC_CHANNELS.ping,
  request: pingRequestSchema,
  response: pingResponseSchema,
} satisfies IpcChannelDefinition<void, string>

export const ipcChannelDefinitions = {
  ping: pingChannel,
} as const
