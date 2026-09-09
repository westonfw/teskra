import { Card, InputNumber, Select, Space, Typography } from 'antd'

import { LOG_LEVELS, type LogLevel } from '@teskra/contracts'

import { ConfigField } from '../config-field'
import { useSettingsStore } from '../settings-store'

export function GeneralSettingsSection() {
  const config = useSettingsStore((state) => state.resolved?.config)
  const save = useSettingsStore((state) => state.save)
  const saving = useSettingsStore((state) => state.saving)

  if (config === undefined) return null

  return (
    <Space direction="vertical" size={18} className="settings-section-stack">
      <div>
        <Typography.Title level={3}>General</Typography.Title>
        <Typography.Paragraph type="secondary">
          Runtime defaults shared by the workbench. Changes are written to the selected layer.
        </Typography.Paragraph>
      </div>

      <Card title="Logging" variant="borderless">
        <ConfigField
          path="logging.level"
          label="Log level"
          description="Controls the minimum severity written to the Teskra log."
        >
          <Select<LogLevel>
            value={config.logging.level}
            loading={saving}
            options={LOG_LEVELS.map((value) => ({ value, label: value.toUpperCase() }))}
            onChange={(level) => void save({ logging: { level } })}
          />
        </ConfigField>
      </Card>

      <Card title="Concurrency" variant="borderless">
        <ConfigField
          path="concurrency.maxGlobalRuns"
          label="Global runs"
          description="Maximum number of Agent runs across all workspaces."
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
          label="Runs per workspace"
          description="Prevents one workspace from occupying every Agent slot."
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
          label="Runs per Agent"
          description="Caps parallel work delegated to a single Agent type."
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

      <Card title="Watchdog" variant="borderless">
        <ConfigField
          path="watchdog.stalledThresholdMs"
          label="Stalled threshold"
          description="Milliseconds without output before a run is marked as possibly stalled."
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
