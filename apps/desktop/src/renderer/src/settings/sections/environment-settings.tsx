import { Alert, Button, Card, Select, Space, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { PublicAppError, WslDistribution } from '@teskra/contracts'

import { ConfigField } from '../config-field'
import { useSettingsStore } from '../settings-store'

export function EnvironmentSettingsSection() {
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
      setError({ code: 'UNKNOWN', message: 'WSL detection failed.', retryable: true })
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
        <Typography.Title level={3}>Environment</Typography.Title>
        <Typography.Paragraph type="secondary">
          Choose the default WSL distribution used when a workspace does not specify one.
        </Typography.Paragraph>
      </div>
      {error !== undefined && (
        <Alert
          type="warning"
          showIcon
          message={error.message}
          action={<Button onClick={() => void inspect()}>Retry</Button>}
        />
      )}
      <Card title="Windows Subsystem for Linux" variant="borderless">
        <ConfigField
          path="environment.defaultDistro"
          label="Default distribution"
          description="This host preference is always saved to the global config layer."
        >
          <Select<string | null>
            allowClear
            placeholder="Use the Windows default"
            loading={loading}
            value={config?.environment.defaultDistro ?? undefined}
            options={distributions.map((distribution) => ({
              value: distribution.name,
              label: distribution.isSystemDefault
                ? `${distribution.name} · Windows default`
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
