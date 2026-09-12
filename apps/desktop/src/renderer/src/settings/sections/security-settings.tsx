import { Alert, Button, Card, Form, Input, List, Popconfirm, Space, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'

import type { PublicAppError } from '@teskra/contracts'

import { useTranslation } from '../../i18n'

/**
 * TASK-088: Credential Store status + key management. The UI only ever sees
 * key names — values are write-only (no get channel by design). When the OS
 * encryption provider is unavailable the form is disabled and the degradation
 * is stated explicitly instead of silently storing plaintext.
 */
export function SecuritySettingsSection() {
  const { t } = useTranslation()
  const [available, setAvailable] = useState<boolean>()
  const [keys, setKeys] = useState<readonly string[]>([])
  const [error, setError] = useState<PublicAppError>()
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<{ key: string; value: string }>()

  const load = useCallback(async (): Promise<void> => {
    setError(undefined)
    const status = await window.teskra.credential.status()
    if (!status.ok) {
      setError(status.error)
      return
    }
    setAvailable(status.data.available)
    const listed = await window.teskra.credential.list()
    if (listed.ok) setKeys(listed.data)
    else setError(listed.error)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const add = async ({ key, value }: { key: string; value: string }): Promise<void> => {
    setSaving(true)
    try {
      const result = await window.teskra.credential.set({ key: key.trim(), value })
      if (result.ok) {
        form.resetFields()
        await load()
      } else {
        setError(result.error)
      }
    } finally {
      setSaving(false)
    }
  }

  const remove = async (key: string): Promise<void> => {
    const result = await window.teskra.credential.delete({ key })
    if (result.ok) await load()
    else setError(result.error)
  }

  return (
    <Space direction="vertical" size={18} className="settings-section-stack">
      <div>
        <Typography.Title level={3}>{t('settings.section.security.title')}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {t('settings.security.subtitle')}
        </Typography.Paragraph>
      </div>
      {available === false && (
        <Alert
          type="warning"
          showIcon
          message={t('settings.security.unavailable.message')}
          description={t('settings.security.unavailable.description')}
        />
      )}
      {error !== undefined && <Alert type="error" showIcon message={error.message} />}
      <Card title={t('settings.security.store.title')} variant="borderless">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            {available === true
              ? t('settings.security.status.available')
              : available === false
                ? t('settings.security.status.unavailable')
                : t('settings.security.status.checking')}
          </Typography.Text>
          <List
            size="small"
            dataSource={[...keys]}
            locale={{ emptyText: t('settings.security.empty') }}
            renderItem={(key) => (
              <List.Item
                actions={[
                  <Popconfirm
                    key="delete"
                    title={t('settings.security.deleteConfirm', { key })}
                    onConfirm={() => void remove(key)}
                  >
                    <Button size="small" danger disabled={available !== true}>
                      {t('settings.security.delete')}
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <Typography.Text code>{key}</Typography.Text>
              </List.Item>
            )}
          />
          <Form form={form} layout="inline" onFinish={(values) => void add(values)}>
            <Form.Item
              name="key"
              rules={[{ required: true, message: t('settings.security.nameRequired') }]}
            >
              <Input
                placeholder={t('settings.security.namePlaceholder')}
                disabled={available !== true}
              />
            </Form.Item>
            <Form.Item
              name="value"
              rules={[{ required: true, message: t('settings.security.valueRequired') }]}
            >
              <Input.Password
                placeholder={t('settings.security.valuePlaceholder')}
                disabled={available !== true}
              />
            </Form.Item>
            <Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                loading={saving}
                disabled={available !== true}
              >
                {t('settings.security.store')}
              </Button>
            </Form.Item>
          </Form>
        </Space>
      </Card>
    </Space>
  )
}
