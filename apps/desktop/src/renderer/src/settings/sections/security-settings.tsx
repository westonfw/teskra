import { Alert, Button, Card, Form, Input, List, Popconfirm, Space, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'

import type { PublicAppError } from '@teskra/contracts'

/**
 * TASK-088: Credential Store status + key management. The UI only ever sees
 * key names — values are write-only (no get channel by design). When the OS
 * encryption provider is unavailable the form is disabled and the degradation
 * is stated explicitly instead of silently storing plaintext.
 */
export function SecuritySettingsSection() {
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
        <Typography.Title level={3}>Security</Typography.Title>
        <Typography.Paragraph type="secondary">
          Sensitive environment variables are stored encrypted through the operating system
          (DPAPI on Windows, the desktop keyring on Linux) and injected into Agent processes at
          launch. Plaintext values are never written to the database, config files, or logs.
        </Typography.Paragraph>
      </div>
      {available === false && (
        <Alert
          type="warning"
          showIcon
          message="Secure storage is unavailable in this environment"
          description="Sensitive variables will not be persisted. Workspace env entries that look like secrets are rejected instead of being stored as plaintext."
        />
      )}
      {error !== undefined && <Alert type="error" showIcon message={error.message} />}
      <Card title="Credential Store" variant="borderless">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            {available === true
              ? 'OS-backed encryption is available.'
              : available === false
                ? 'OS-backed encryption is unavailable.'
                : 'Checking availability…'}
          </Typography.Text>
          <List
            size="small"
            dataSource={[...keys]}
            locale={{ emptyText: 'No credentials stored.' }}
            renderItem={(key) => (
              <List.Item
                actions={[
                  <Popconfirm
                    key="delete"
                    title={`Delete credential "${key}"?`}
                    onConfirm={() => void remove(key)}
                  >
                    <Button size="small" danger disabled={available !== true}>
                      Delete
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <Typography.Text code>{key}</Typography.Text>
              </List.Item>
            )}
          />
          <Form form={form} layout="inline" onFinish={(values) => void add(values)}>
            <Form.Item name="key" rules={[{ required: true, message: 'Name is required.' }]}>
              <Input placeholder="Name (e.g. OPENAI_API_KEY)" disabled={available !== true} />
            </Form.Item>
            <Form.Item name="value" rules={[{ required: true, message: 'Value is required.' }]}>
              <Input.Password placeholder="Value (write-only)" disabled={available !== true} />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={saving} disabled={available !== true}>
                Store
              </Button>
            </Form.Item>
          </Form>
        </Space>
      </Card>
    </Space>
  )
}
