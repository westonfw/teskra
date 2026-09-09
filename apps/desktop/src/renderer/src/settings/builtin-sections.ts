import { AdvancedSettingsSection } from './sections/advanced-settings'
import { AgentsSettingsSection } from './sections/agents-settings'
import { EnvironmentSettingsSection } from './sections/environment-settings'
import { GeneralSettingsSection } from './sections/general-settings'
import type { SettingsSectionRegistry } from './registry'

export function registerBuiltInSettings(registry: SettingsSectionRegistry): void {
  registry.register({
    id: 'agents',
    title: 'Agents',
    description: 'Installed coding Agent integrations',
    order: 30,
    component: AgentsSettingsSection,
  })
  registry.register({
    id: 'general',
    title: 'General',
    description: 'Logging and runtime defaults',
    order: 10,
    component: GeneralSettingsSection,
  })
  registry.register({
    id: 'environment',
    title: 'Environment',
    description: 'Windows and WSL',
    order: 20,
    component: EnvironmentSettingsSection,
  })
  registry.register({
    id: 'advanced',
    title: 'Advanced',
    description: 'Diagnostics and local data',
    order: 90,
    component: AdvancedSettingsSection,
  })
}
