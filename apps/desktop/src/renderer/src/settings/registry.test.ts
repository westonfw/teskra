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
      title: 'settings.section.advanced.title',
      description: 'settings.section.advanced.description',
      order: 30,
      component: EmptySection,
    })
    registry.register({
      id: 'general',
      title: 'settings.section.general.title',
      description: 'settings.section.general.description',
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
      title: 'settings.section.general.title',
      description: 'settings.section.general.description',
      order: 10,
      component: EmptySection,
    } as const
    registry.register(section)
    expect(() => registry.register(section)).toThrow(/already registered/u)
  })
})
