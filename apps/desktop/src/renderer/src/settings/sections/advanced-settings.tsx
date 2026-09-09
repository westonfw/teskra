import { FolderOpenOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Space, Typography } from 'antd'

import { useSettingsStore } from '../settings-store'

export function AdvancedSettingsSection() {
  const openDirectory = useSettingsStore((state) => state.openDirectory)

  return (
    <Space direction="vertical" size={18} className="settings-section-stack">
      <div>
        <Typography.Title level={3}>Advanced</Typography.Title>
        <Typography.Paragraph type="secondary">
          Diagnostics, local data, and security-sensitive capabilities.
        </Typography.Paragraph>
      </div>

      <Card title="Local directories" variant="borderless">
        <Space wrap>
          <Button icon={<FolderOpenOutlined />} onClick={() => void openDirectory('logs')}>
            Open logs
          </Button>
          <Button icon={<FolderOpenOutlined />} onClick={() => void openDirectory('data')}>
            Open data directory
          </Button>
        </Space>
      </Card>

      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        message="Sensitive settings are unavailable"
        description="API keys, tokens, and other secrets cannot be entered until Credential Store support is available. Teskra will not save them in config files."
      />
    </Space>
  )
}
