import { App as AntApp, ConfigProvider, theme } from 'antd'
import antdEnUS from 'antd/locale/en_US'
import antdZhCN from 'antd/locale/zh_CN'
import { useEffect } from 'react'
import type { JSX } from 'react'

import { useLocaleStore } from './i18n'
import { registerBuiltInSettings } from './settings/builtin-sections'
import { createSettingsSectionRegistry } from './settings/registry'
import { AppShell } from './shell/app-shell'
import { useTerminalStore } from './stores/terminal-store'
import { useThemeStore } from './theme/theme-store'

const settingsRegistry = createSettingsSectionRegistry()
registerBuiltInSettings(settingsRegistry)

function App(): JSX.Element {
  useEffect(() => useTerminalStore.getState().startSynchronization(), [])
  const locale = useLocaleStore((state) => state.locale)
  const mode = useThemeStore((state) => state.theme)
  const isDark = mode === 'dark'

  useEffect(() => {
    document.documentElement.dataset.theme = mode
  }, [mode])

  return (
    <ConfigProvider
      locale={locale === 'zh-CN' ? antdZhCN : antdEnUS}
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: isDark ? '#65cfc5' : '#0f9b8e',
          colorBgBase: isDark ? '#0b0f17' : '#f5f7fa',
          colorBgContainer: isDark ? '#141b28' : '#ffffff',
          borderRadius: 10,
          fontSize: 14,
        },
      }}
    >
      <AntApp>
        <AppShell settingsRegistry={settingsRegistry} />
      </AntApp>
    </ConfigProvider>
  )
}

export default App
