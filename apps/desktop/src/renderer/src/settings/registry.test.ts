import { describe, expect, it, vi } from 'vitest'

import { createSettingsSectionRegistry } from './registry'

const EmptySection = (): null => null

describe('Settings section registry', () => {
  it('orders feature-owned sections and publishes registration changes', () => {
    const registry = createSettingsSectionRegistry()
    const changed = vi.fn()
    const stopListening = registry.subscribe(changed)
    const removeAdvanced = registry.register({
      id: 'advanced',
      title: 'Advanced',
      description: 'Paths',
      order: 30,
      component: EmptySection,
    })
    registry.register({
      id: 'general',
      title: 'General',
      description: 'General options',
      order: 10,
      component: EmptySection,
    })

    expect(registry.getSnapshot().map((section) => section.id)).toEqual(['general', 'advanced'])
    expect(changed).toHaveBeenCalledTimes(2)
    removeAdvanced()
    removeAdvanced()
    expect(registry.getSnapshot().map((section) => section.id)).toEqual(['general'])
    expect(changed).toHaveBeenCalledTimes(3)
    stopListening()
  })

  it('rejects duplicate ids so navigation never renders duplicate sections', () => {
    const registry = createSettingsSectionRegistry()
    const section = {
      id: 'general',
      title: 'General',
      description: 'General options',
      order: 10,
      component: EmptySection,
    }
    registry.register(section)
    expect(() => registry.register(section)).toThrow(/already registered/u)
  })
})
