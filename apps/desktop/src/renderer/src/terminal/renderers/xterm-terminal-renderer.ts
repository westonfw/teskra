import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import type {
  TerminalInstance,
  TerminalRenderer,
  TerminalRendererOptions,
} from './terminal-renderer'

/** The only module allowed to know about xterm.js (TASK-082). */
export class XtermTerminalRenderer implements TerminalRenderer {
  mount(element: HTMLElement, options: TerminalRendererOptions): TerminalInstance {
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.18,
      scrollback: 10_000,
      allowProposedApi: false,
      disableStdin: options.readOnly ?? false,
      theme: {
        background: '#090d14',
        foreground: '#d9e2ef',
        cursor: '#70ddd1',
        cursorAccent: '#090d14',
        selectionBackground: '#2d5e6d99',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)
    if (options.initialData !== undefined) terminal.write(options.initialData)

    return {
      write: (data) => terminal.write(data),
      onData: (handler) => terminal.onData(handler),
      onResize: (handler) => terminal.onResize(handler),
      fit: () => fit.fit(),
      setReadOnly: (readOnly) => {
        terminal.options.disableStdin = readOnly
      },
      dispose: () => terminal.dispose(),
    }
  }
}
