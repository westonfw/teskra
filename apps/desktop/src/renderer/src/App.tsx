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

  // One neutral slate scale for both themes; the teal accent is reserved for
  // primary actions, links, and selected states. The same values are mirrored
  // in styles.css custom properties (that file cannot read antd tokens).
  const accent = isDark ? '#65cfc5' : '#0f9b8e'
  const colorText = isDark ? '#e8edf5' : '#1f2733'
  const colorTextSecondary = isDark ? 'rgba(232, 237, 245, 0.64)' : 'rgba(31, 39, 51, 0.62)'
  const colorTextTertiary = isDark ? 'rgba(232, 237, 245, 0.44)' : 'rgba(31, 39, 51, 0.42)'

  return (
    <ConfigProvider
      locale={locale === 'zh-CN' ? antdZhCN : antdEnUS}
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: accent,
          colorInfo: accent,
          colorLink: accent,
          colorBgBase: isDark ? '#0d1117' : '#f5f7fa',
          colorBgContainer: isDark ? '#161c26' : '#ffffff',
          colorBgElevated: isDark ? '#1b2330' : '#ffffff',
          colorBorder: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(15, 23, 42, 0.12)',
          colorBorderSecondary: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(15, 23, 42, 0.08)',
          colorText,
          colorTextSecondary,
          colorTextTertiary,
          borderRadius: 8,
          borderRadiusLG: 10,
          fontSize: 14,
        },
        components: {
          Layout: {
            bodyBg: 'transparent',
            headerBg: 'transparent',
            siderBg: 'transparent',
          },
          Menu: {
            itemBg: 'transparent',
            itemColor: colorTextSecondary,
            itemHoverBg: isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(15, 23, 42, 0.05)',
            itemHoverColor: colorText,
            itemSelectedBg: isDark ? 'rgba(101, 207, 197, 0.12)' : 'rgba(15, 155, 142, 0.1)',
            itemSelectedColor: accent,
            itemBorderRadius: 8,
            itemHeight: 38,
            itemMarginInline: 8,
            iconSize: 15,
          },
          Button: {
            primaryShadow: 'none',
          },
          Card: {
            paddingLG: 20,
          },
          Tag: {
            defaultBg: isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(15, 23, 42, 0.05)',
            defaultColor: colorTextSecondary,
          },
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
