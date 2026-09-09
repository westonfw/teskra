import { describe, expect, it } from 'vitest'

import type { TerminalRenderer } from './terminal-renderer'
import { TerminalRendererRegistry } from './terminal-renderer'

const renderer: TerminalRenderer = {
  mount: () => {
    throw new Error('not used')
  },
}

describe('TerminalRendererRegistry', () => {
  it('selects the default implementation and supports feature registrations', () => {
    const registry = new TerminalRendererRegistry('test')
    const unregister = registry.register('test', renderer)
    expect(registry.get()).toBe(renderer)
    unregister()
    unregister()
    expect(() => registry.get()).toThrow(/not registered/u)
  })

  it('rejects duplicate renderer names', () => {
    const registry = new TerminalRendererRegistry()
    registry.register('xterm', renderer)
    expect(() => registry.register('xterm', renderer)).toThrow(/already exists/u)
  })
})
