import { Card, InputNumber, Select, Space, Typography } from 'antd'

import { LOG_LEVELS, type LogLevel } from '@teskra/contracts'

import { useTranslation } from '../../i18n'
import { ConfigField } from '../config-field'
import { useSettingsStore } from '../settings-store'

export function GeneralSettingsSection() {
  const { t } = useTranslation()
  const config = useSettingsStore((state) => state.resolved?.config)
  const save = useSettingsStore((state) => state.save)
  const saving = useSettingsStore((state) => state.saving)

  if (config === undefined) return null

  return (
    <Space direction="vertical" size={18} className="settings-section-stack">
      <div>
        <Typography.Title level={3}>{t('settings.section.general.title')}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {t('settings.general.subtitle')}
        </Typography.Paragraph>
      </div>

      <Card title={t('settings.general.logging.title')} variant="borderless">
        <ConfigField
          path="logging.level"
          label={t('settings.general.logging.level.label')}
          description={t('settings.general.logging.level.description')}
        >
          <Select<LogLevel>
            value={config.logging.level}
            loading={saving}
            options={LOG_LEVELS.map((value) => ({
              value,
              label: t(`settings.general.logging.level.${value}`),
            }))}
            onChange={(level) => void save({ logging: { level } })}
          />
        </ConfigField>
      </Card>

      <Card title={t('settings.general.concurrency.title')} variant="borderless">
        <ConfigField
          path="concurrency.maxGlobalRuns"
          label={t('settings.general.concurrency.maxGlobalRuns.label')}
          description={t('settings.general.concurrency.maxGlobalRuns.description')}
        >
          <InputNumber
            min={1}
            precision={0}
            value={config.concurrency.maxGlobalRuns}
            disabled={saving}
            onChange={(value) => {
              if (value !== null) void save({ concurrency: { maxGlobalRuns: value } })
            }}
          />
        </ConfigField>
        <ConfigField
          path="concurrency.maxRunsPerWorkspace"
          label={t('settings.general.concurrency.maxRunsPerWorkspace.label')}
          description={t('settings.general.concurrency.maxRunsPerWorkspace.description')}
        >
          <InputNumber
            min={1}
            precision={0}
            value={config.concurrency.maxRunsPerWorkspace}
            disabled={saving}
            onChange={(value) => {
              if (value !== null) void save({ concurrency: { maxRunsPerWorkspace: value } })
            }}
          />
        </ConfigField>
        <ConfigField
          path="concurrency.maxRunsPerAgent"
          label={t('settings.general.concurrency.maxRunsPerAgent.label')}
          description={t('settings.general.concurrency.maxRunsPerAgent.description')}
        >
          <InputNumber
            min={1}
            precision={0}
            value={config.concurrency.maxRunsPerAgent}
            disabled={saving}
            onChange={(value) => {
              if (value !== null) void save({ concurrency: { maxRunsPerAgent: value } })
            }}
          />
        </ConfigField>
      </Card>

      <Card title={t('settings.general.watchdog.title')} variant="borderless">
        <ConfigField
          path="watchdog.stalledThresholdMs"
          label={t('settings.general.watchdog.stalledThreshold.label')}
          description={t('settings.general.watchdog.stalledThreshold.description')}
        >
          <InputNumber
            min={1000}
            step={30_000}
            precision={0}
            value={config.watchdog.stalledThresholdMs}
            disabled={saving}
            onChange={(value) => {
              if (value !== null) void save({ watchdog: { stalledThresholdMs: value } })
            }}
          />
        </ConfigField>
      </Card>
    </Space>
  )
}
