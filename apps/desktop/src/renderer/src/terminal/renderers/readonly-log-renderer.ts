import type {
  TerminalInstance,
  TerminalRenderer,
  TerminalRendererOptions,
} from './terminal-renderer'

/**
 * Lightweight non-interactive placeholder for completed Run output. A future
 * history task can replace this registration without changing TerminalView.
 */
export class ReadonlyLogRenderer implements TerminalRenderer {
  mount(element: HTMLElement, options: TerminalRendererOptions): TerminalInstance {
    const output = document.createElement('pre')
    output.className = 'readonly-terminal-log'
    output.textContent = options.initialData ?? ''
    element.append(output)
    const disposable = { dispose: () => undefined }

    return {
      write(data) {
        output.textContent += data
        output.scrollTop = output.scrollHeight
      },
      onData: () => disposable,
      onResize: () => disposable,
      fit: () => undefined,
      setReadOnly: () => undefined,
      dispose: () => output.remove(),
    }
  }
}
