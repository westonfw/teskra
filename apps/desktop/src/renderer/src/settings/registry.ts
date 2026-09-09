import type { ComponentType } from 'react'

export interface SettingsSectionDefinition {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly order: number
  readonly component: ComponentType
}

export interface SettingsSectionRegistry {
  register(section: SettingsSectionDefinition): () => void
  getSnapshot(): readonly SettingsSectionDefinition[]
  subscribe(listener: () => void): () => void
}

/** Extension point for feature-owned Settings sections (TASK-093). */
export function createSettingsSectionRegistry(): SettingsSectionRegistry {
  const sections = new Map<string, SettingsSectionDefinition>()
  const listeners = new Set<() => void>()
  let snapshot: readonly SettingsSectionDefinition[] = []

  const publish = (): void => {
    snapshot = [...sections.values()].sort(
      (left, right) => left.order - right.order || left.title.localeCompare(right.title),
    )
    for (const listener of [...listeners]) listener()
  }

  return {
    register(section) {
      if (sections.has(section.id)) {
        throw new Error(`Settings section "${section.id}" is already registered.`)
      }
      sections.set(section.id, section)
      publish()
      let registered = true
      return () => {
        if (!registered) return
        registered = false
        sections.delete(section.id)
        publish()
      }
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
