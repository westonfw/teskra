export * from './error'
export * from './workspace'
export * from './task'
export * from './agent'
export * from './terminal'
export * from './git'
export * from './artifact'
export * from './memory'
export * from './workflow'
export * from './handoff'
export * from './event'
export * from './ipc'
export * from './config'
export * from './wsl'
export * from './system'

/**
 * Bridge API exposed to the Renderer as `window.teskra` via contextBridge.
 *
 * Runtime values from this package (channel names, Zod schemas) may be
 * imported by the preload bundle — electron-vite bundles all non-electron
 * dependencies into it, which is required under `sandbox: true`.
 */
export interface TeskraBridge {
  readonly appName: 'Teskra'
  readonly appVersion: string
  ping(): Promise<string>
}
