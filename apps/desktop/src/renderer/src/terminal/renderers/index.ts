import { ReadonlyLogRenderer } from './readonly-log-renderer'
import { TerminalRendererRegistry } from './terminal-renderer'
import { XtermTerminalRenderer } from './xterm-terminal-renderer'

export type {
  TerminalInstance,
  TerminalRenderer,
  TerminalRendererOptions,
} from './terminal-renderer'
export { TerminalRendererRegistry } from './terminal-renderer'

export const terminalRenderers = new TerminalRendererRegistry()
terminalRenderers.register('xterm', new XtermTerminalRenderer())
terminalRenderers.register('readonly-log', new ReadonlyLogRenderer())
