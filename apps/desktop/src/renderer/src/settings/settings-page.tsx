import { Alert, Layout, Menu, Segmented, Spin, Typography } from 'antd'
import { useEffect, useState, useSyncExternalStore } from 'react'

import type { ResolvedConfig, WritableConfigLayer } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
import type { SettingsSectionRegistry } from './registry'
import { useSettingsStore } from './settings-store'

const NO_WARNINGS: ResolvedConfig['warnings'] = []

interface SettingsPageProps {
  readonly registry: SettingsSectionRegistry
  readonly workspaceId?: string | undefined
}

export function SettingsPage({ registry, workspaceId: selectedWorkspaceId }: SettingsPageProps) {
  const { t } = useTranslation()
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
            <Typography.Text type="secondary">{t('nav.settings')}</Typography.Text>
          </div>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[activeId]}
          items={sections.map((section) => ({
            key: section.id,
            label: t(section.title),
            title: t(section.description),
          }))}
          onSelect={({ key }) => setActiveId(key)}
        />
      </Layout.Sider>

      <Layout.Content className="settings-content">
        <header className="settings-toolbar">
          <div>
            <Typography.Text className="settings-eyebrow">{t('settings.eyebrow')}</Typography.Text>
            <Typography.Paragraph type="secondary">
              {t('settings.layerDescription')}
            </Typography.Paragraph>
          </div>
          <Segmented<WritableConfigLayer>
            value={targetLayer}
            options={[
              { label: t('settings.layer.global'), value: 'global' },
              {
                label: t('settings.layer.workspace'),
                value: 'workspace',
                disabled: workspaceId === undefined,
              },
            ]}
            onChange={setTargetLayer}
          />
        </header>

        {workspaceId === undefined && (
          <Alert
            className="settings-notice"
            type="info"
            showIcon
            message={t('workspace.empty.title')}
            description={t('settings.noWorkspaceBody')}
          />
        )}
        {error !== undefined && (
          <AppErrorAlert className="settings-notice" error={error} onClose={clearError} />
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
          <Spin spinning={loading} tip={t('settings.loading')}>
            {ActiveSection === undefined ? (
              <Alert type="info" message={t('settings.noSections')} />
            ) : (
              <ActiveSection />
            )}
          </Spin>
        </div>
      </Layout.Content>
    </Layout>
  )
}
