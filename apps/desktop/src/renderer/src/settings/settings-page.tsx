import { Alert, Layout, Menu, Segmented, Spin, Typography } from 'antd'
import { useEffect, useState, useSyncExternalStore } from 'react'

import type { ResolvedConfig, WritableConfigLayer } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import type { SettingsSectionRegistry } from './registry'
import { useSettingsStore } from './settings-store'

const NO_WARNINGS: ResolvedConfig['warnings'] = []

interface SettingsPageProps {
  readonly registry: SettingsSectionRegistry
  readonly workspaceId?: string
}

export function SettingsPage({ registry, workspaceId: selectedWorkspaceId }: SettingsPageProps) {
  const sections = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  const [activeId, setActiveId] = useState(sections[0]?.id ?? '')
  const workspaceId = useSettingsStore((state) => state.workspaceId)
  const setWorkspace = useSettingsStore((state) => state.setWorkspace)
  const targetLayer = useSettingsStore((state) => state.targetLayer)
  const setTargetLayer = useSettingsStore((state) => state.setTargetLayer)
  const loading = useSettingsStore((state) => state.loading)
  const error = useSettingsStore((state) => state.error)
  const clearError = useSettingsStore((state) => state.clearError)
  const warnings = useSettingsStore((state) => state.resolved?.warnings ?? NO_WARNINGS)

  useEffect(() => {
    void setWorkspace(selectedWorkspaceId)
  }, [selectedWorkspaceId, setWorkspace])

  useEffect(() => {
    if (!sections.some((section) => section.id === activeId)) {
      setActiveId(sections[0]?.id ?? '')
    }
  }, [activeId, sections])

  const active = sections.find((section) => section.id === activeId)
  const ActiveSection = active?.component

  return (
    <Layout className="settings-layout">
      <Layout.Sider width={260} className="settings-sidebar">
        <div className="settings-brand">
          <span className="settings-brand-mark">T</span>
          <div>
            <Typography.Title level={4}>Teskra</Typography.Title>
            <Typography.Text type="secondary">Settings</Typography.Text>
          </div>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[activeId]}
          items={sections.map((section) => ({
            key: section.id,
            label: section.title,
            title: section.description,
          }))}
          onSelect={({ key }) => setActiveId(key)}
        />
      </Layout.Sider>

      <Layout.Content className="settings-content">
        <header className="settings-toolbar">
          <div>
            <Typography.Text className="settings-eyebrow">CONFIGURATION LAYER</Typography.Text>
            <Typography.Paragraph type="secondary">
              Choose where edits are stored. Every field shows the layer currently supplying it.
            </Typography.Paragraph>
          </div>
          <Segmented<WritableConfigLayer>
            value={targetLayer}
            options={[
              { label: 'Global', value: 'global' },
              { label: 'Workspace', value: 'workspace', disabled: workspaceId === undefined },
            ]}
            onChange={setTargetLayer}
          />
        </header>

        {workspaceId === undefined && (
          <Alert
            className="settings-notice"
            type="info"
            showIcon
            message="No workspace is open"
            description="Global settings remain available. Open a workspace to read or write its repository-local configuration."
          />
        )}
        {error !== undefined && (
          <AppErrorAlert
            className="settings-notice"
            error={error}
            onClose={clearError}
          />
        )}
        {warnings.map((warning) => (
          <Alert
            className="settings-notice"
            key={`${warning.layer}:${warning.fieldPath ?? warning.message}`}
            type="warning"
            showIcon
            message={warning.message}
          />
        ))}

        <div className="settings-panel">
          <Spin spinning={loading} tip="Loading configuration…">
            {ActiveSection === undefined ? (
              <Alert type="info" message="No Settings sections are registered." />
            ) : (
              <ActiveSection />
            )}
          </Spin>
        </div>
      </Layout.Content>
    </Layout>
  )
}
