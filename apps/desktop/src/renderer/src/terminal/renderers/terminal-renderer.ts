import type { TerminalSurface } from '../terminal-session-binding'

export interface TerminalRendererOptions {
  readonly initialData?: string
  readonly readOnly?: boolean
}

export interface TerminalInstance extends TerminalSurface {
  fit(): void
  setReadOnly(readOnly: boolean): void
  dispose(): void
}

export interface TerminalRenderer {
  mount(element: HTMLElement, options: TerminalRendererOptions): TerminalInstance
}

/** Feature-neutral registry; UI code depends on this contract, never xterm. */
export class TerminalRendererRegistry {
  private readonly renderers = new Map<string, TerminalRenderer>()

  constructor(private readonly defaultName = 'xterm') {}

  register(name: string, renderer: TerminalRenderer): () => void {
    if (name.length === 0) throw new Error('Terminal renderer name cannot be empty.')
    if (this.renderers.has(name)) throw new Error(`Terminal renderer "${name}" already exists.`)
    this.renderers.set(name, renderer)
    let registered = true
    return () => {
      if (!registered) return
      registered = false
      this.renderers.delete(name)
    }
  }

  get(name = this.defaultName): TerminalRenderer {
    const renderer = this.renderers.get(name)
    if (renderer === undefined) throw new Error(`Terminal renderer "${name}" is not registered.`)
    return renderer
  }
}
