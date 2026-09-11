import type { TeskraBridge } from '@teskra/contracts'

declare global {
  interface Window {
    /** The contextBridge surface exposed by apps/desktop/src/preload. */
    teskra: TeskraBridge
  }
}

export {}
