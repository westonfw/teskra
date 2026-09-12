import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import { useThemeStore } from '../../theme/theme-store'
import type {
  TerminalInstance,
  TerminalRenderer,
  TerminalRendererOptions,
} from './terminal-renderer'
import { xtermThemes } from './xterm-themes'

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
      // Agent TUIs emit white/bright-white text even under a light theme;
      // let xterm pull any low-contrast foreground up to WCAG AA instead of
      // rendering invisible glyphs.
      minimumContrastRatio: 4.5,
      allowProposedApi: false,
      disableStdin: options.readOnly ?? false,
      theme: xtermThemes[useThemeStore.getState().theme],
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)
    if (options.initialData !== undefined) terminal.write(options.initialData)
    const unsubscribeTheme = useThemeStore.subscribe((state) => {
      terminal.options.theme = xtermThemes[state.theme]
    })

    return {
      write: (data) => terminal.write(data),
      onData: (handler) => terminal.onData(handler),
      onResize: (handler) => terminal.onResize(handler),
      fit: () => fit.fit(),
      setReadOnly: (readOnly) => {
        terminal.options.disableStdin = readOnly
      },
      dispose: () => {
        unsubscribeTheme()
        terminal.dispose()
      },
    }
  }
}
