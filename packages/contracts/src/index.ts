/**
 * Bridge API exposed to the Renderer as `window.teskra` via contextBridge.
 *
 * Keep this file type-only until TASK-003: a sandboxed preload script can only
 * require `electron`, so runtime values imported from this package would have
 * to be bundled into the preload bundle. Type imports are erased at compile
 * time and are always safe.
 */
export interface TeskraBridge {
  readonly appName: 'Teskra'
  readonly appVersion: string
  ping(): Promise<string>
}
