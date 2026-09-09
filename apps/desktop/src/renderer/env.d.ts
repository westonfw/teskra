/// <reference types="vite/client" />

import type { TeskraBridge } from '@teskra/contracts'

declare global {
  interface Window {
    teskra: TeskraBridge
  }
}

export {}
