import { contextBridge, ipcRenderer } from 'electron'

import { IPC_CHANNELS, type TeskraBridge } from '@teskra/contracts'

// sandbox: true allows a preload script to require `electron` only, so this
// bundle must stay self-contained — @teskra/contracts (and its zod
// dependency) are bundled in by electron-vite, not externalized.
const bridge: TeskraBridge = {
  appName: 'Teskra',
  appVersion: '0.1.0',
  ping: () => ipcRenderer.invoke(IPC_CHANNELS.ping) as Promise<string>,
}

contextBridge.exposeInMainWorld('teskra', bridge)
