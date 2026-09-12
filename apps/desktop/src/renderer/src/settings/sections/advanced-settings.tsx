import { FolderOpenOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Space, Typography } from 'antd'

import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../settings-store'

export function AdvancedSettingsSection() {
  const { t } = useTranslation()
  const openDirectory = useSettingsStore((state) => state.openDirectory)

  return (
    <Space direction="vertical" size={18} className="settings-section-stack">
      <div>
        <Typography.Title level={3}>{t('settings.section.advanced.title')}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {t('settings.advanced.subtitle')}
        </Typography.Paragraph>
      </div>

      <Card title={t('settings.advanced.localDirectories')} variant="borderless">
        <Space wrap>
          <Button icon={<FolderOpenOutlined />} onClick={() => void openDirectory('logs')}>
            {t('settings.advanced.openLogs')}
          </Button>
          <Button icon={<FolderOpenOutlined />} onClick={() => void openDirectory('data')}>
            {t('settings.advanced.openDataDirectory')}
          </Button>
        </Space>
      </Card>

      <Alert
        type="info"
        showIcon
        icon={<SafetyCertificateOutlined />}
        message={t('settings.advanced.credentialStore.message')}
        description={t('settings.advanced.credentialStore.description')}
      />
    </Space>
  )
}
