import { safeStorage } from 'electron'

import type { CredentialCipher } from './credential-store'

/**
 * TASK-088: the only Electron-backed CredentialCipher. safeStorage uses DPAPI
 * on Windows and the desktop keyring (kwallet / gnome-keyring) on Linux;
 * isEncryptionAvailable() === false drives the Credential Store's explicit
 * degradation. Imported solely by main/index.ts — the Runtime layer receives
 * the cipher by injection and never imports electron itself.
 */
export function createSafeStorageCipher(): CredentialCipher {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext).toString('base64'),
    decrypt: (ciphertext) => safeStorage.decryptString(Buffer.from(ciphertext, 'base64')),
  }
}
