import { Alert, Button, Card, Select, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { PublicAppError, WslDistribution } from '@teskra/contracts'

import { useTranslation } from '../../i18n'
import { ConfigField } from '../config-field'
import { useSettingsStore } from '../settings-store'

export function EnvironmentSettingsSection() {
  const { t } = useTranslation()
  const config = useSettingsStore((state) => state.resolved?.config)
  const loadConfig = useSettingsStore((state) => state.load)
  const [distributions, setDistributions] = useState<readonly WslDistribution[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<PublicAppError>()

  const inspect = async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      const result = await window.teskra.runtime.listWslDistributions()
      if (result.ok) setDistributions(result.data)
      else setError(result.error)
    } catch {
      setError({
        code: 'UNKNOWN',
        message: t('settings.environment.wslDetectFailed'),
        retryable: true,
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void inspect()
  }, [])

  return (
    <Space direction="vertical" size={18} className="settings-section-stack">
      <div>
        <Typography.Title level={3}>{t('settings.section.environment.title')}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {t('settings.environment.subtitle')}
        </Typography.Paragraph>
      </div>
      {error !== undefined && (
        <Alert
          type="warning"
          showIcon
          message={error.message}
          action={<Button onClick={() => void inspect()}>{t('settings.environment.retry')}</Button>}
        />
      )}
      <Card title={t('settings.environment.wslCardTitle')} variant="borderless">
        <ConfigField
          path="environment.defaultDistro"
          label={t('settings.environment.defaultDistro.label')}
          description={t('settings.environment.defaultDistro.description')}
        >
          <Select<string | null>
            allowClear
            placeholder={t('settings.environment.defaultDistro.placeholder')}
            loading={loading}
            value={config?.environment.defaultDistro ?? undefined}
            options={distributions.map((distribution) => ({
              value: distribution.name,
              label: distribution.isSystemDefault
                ? t('settings.environment.distroDefault', { name: distribution.name })
                : distribution.name,
            }))}
            onChange={async (name) => {
              const result = await window.teskra.runtime.setDefaultWslDistribution({
                name: name ?? null,
              })
              if (result.ok) await loadConfig()
              else setError(result.error)
            }}
          />
        </ConfigField>
      </Card>
    </Space>
  )
}
