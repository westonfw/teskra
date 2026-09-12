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

const settingsRegistry = createSettingsSectionRegistry()
registerBuiltInSettings(settingsRegistry)

function App(): JSX.Element {
  useEffect(() => useTerminalStore.getState().startSynchronization(), [])
  const locale = useLocaleStore((state) => state.locale)

  return (
    <ConfigProvider
      locale={locale === 'zh-CN' ? antdZhCN : antdEnUS}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#65cfc5',
          colorBgBase: '#0b0f17',
          colorBgContainer: '#141b28',
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
