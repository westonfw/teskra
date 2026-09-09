import { contextBridge, ipcRenderer } from 'electron'

import type { TeskraBridge } from '@teskra/contracts'

// sandbox: true allows a preload script to require `electron` only, so this
// bundle must stay self-contained. The contracts import above is type-only
// and is erased at compile time.
const bridge: TeskraBridge = {
  appName: 'Teskra',
  appVersion: '0.1.0',
  ping: () => ipcRenderer.invoke('teskra:ping') as Promise<string>,
}

contextBridge.exposeInMainWorld('teskra', bridge)
