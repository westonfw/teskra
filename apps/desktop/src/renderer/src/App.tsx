import { App as AntApp, ConfigProvider, theme } from 'antd'
import { useEffect } from 'react'
import type { JSX } from 'react'

import { registerBuiltInSettings } from './settings/builtin-sections'
import { createSettingsSectionRegistry } from './settings/registry'
import { SettingsPage } from './settings/settings-page'
import { useTerminalStore } from './stores/terminal-store'

const settingsRegistry = createSettingsSectionRegistry()
registerBuiltInSettings(settingsRegistry)

function App(): JSX.Element {
  useEffect(() => useTerminalStore.getState().startSynchronization(), [])

  return (
    <ConfigProvider
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
        <SettingsPage registry={settingsRegistry} />
      </AntApp>
    </ConfigProvider>
  )
}

export default App
