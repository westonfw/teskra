import { AdvancedSettingsSection } from './sections/advanced-settings'
import { AgentsSettingsSection } from './sections/agents-settings'
import { EnvironmentSettingsSection } from './sections/environment-settings'
import { GeneralSettingsSection } from './sections/general-settings'
import { PermissionsSettingsSection } from './sections/permissions-settings'
import { SecuritySettingsSection } from './sections/security-settings'
import type { SettingsSectionRegistry } from './registry'

export function registerBuiltInSettings(registry: SettingsSectionRegistry): void {
  registry.register({
    id: 'agents',
    title: 'settings.section.agents.title',
    description: 'settings.section.agents.description',
    order: 30,
    component: AgentsSettingsSection,
  })
  registry.register({
    id: 'permissions',
    title: 'settings.section.permissions.title',
    description: 'settings.section.permissions.description',
    order: 40,
    component: PermissionsSettingsSection,
  })
  registry.register({
    id: 'security',
    title: 'settings.section.security.title',
    description: 'settings.section.security.description',
    order: 35,
    component: SecuritySettingsSection,
  })
  registry.register({
    id: 'general',
    title: 'settings.section.general.title',
    description: 'settings.section.general.description',
    order: 10,
    component: GeneralSettingsSection,
  })
  registry.register({
    id: 'environment',
    title: 'settings.section.environment.title',
    description: 'settings.section.environment.description',
    order: 20,
    component: EnvironmentSettingsSection,
  })
  registry.register({
    id: 'advanced',
    title: 'settings.section.advanced.title',
    description: 'settings.section.advanced.description',
    order: 90,
    component: AdvancedSettingsSection,
  })
}
