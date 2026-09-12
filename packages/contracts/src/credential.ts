import { z } from 'zod'

import { IPC_TEXT_MAX, ipcNameSchema } from './limits'

/**
 * Credential Store contracts (TASK-088, teskra-tasks.md; plan §60).
 *
 * The Renderer may store, delete, and enumerate credential KEYS — plaintext
 * values never cross IPC back to the Renderer (there is deliberately no
 * `get` channel). Values live encrypted under the Teskra data root, written
 * through the OS-backed cipher (Electron safeStorage) in the Main process.
 */

/** Availability of the OS-backed encryption provider (safeStorage). */
export const credentialStoreStatusSchema = z.strictObject({
  available: z.boolean(),
})
export type CredentialStoreStatus = z.infer<typeof credentialStoreStatusSchema>

export const setCredentialRequestSchema = z.strictObject({
  key: ipcNameSchema,
  value: z.string().min(1).max(IPC_TEXT_MAX),
})
export type SetCredentialRequest = z.infer<typeof setCredentialRequestSchema>

export const deleteCredentialRequestSchema = z.strictObject({
  key: ipcNameSchema,
})
export type DeleteCredentialRequest = z.infer<typeof deleteCredentialRequestSchema>
