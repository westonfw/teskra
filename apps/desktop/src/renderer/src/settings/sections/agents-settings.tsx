import { Card, Empty, Space, Spin, Tag, Typography } from 'antd'
import { useEffect } from 'react'

import { AppErrorAlert } from '../../components/app-error-alert'
import { useAgentStore } from '../../stores/agent-store'

export function AgentsSettingsSection() {
  const definitions = useAgentStore((state) => state.definitions)
  const loading = useAgentStore((state) => state.loading)
  const error = useAgentStore((state) => state.error)
  const loadDefinitions = useAgentStore((state) => state.loadDefinitions)
  const clearError = useAgentStore((state) => state.clearError)

  useEffect(() => {
    void loadDefinitions()
  }, [loadDefinitions])

  return (
    <Space direction="vertical" size={18} className="settings-section-stack">
      <div>
        <Typography.Text className="settings-eyebrow">REGISTRY</Typography.Text>
        <Typography.Title level={3}>Coding Agents</Typography.Title>
        <Typography.Paragraph type="secondary">
          Agent entries and capabilities come from the Main-process Registry.
        </Typography.Paragraph>
      </div>
      {error !== undefined && <AppErrorAlert error={error} onClose={clearError} />}
      <Spin spinning={loading} tip="Loading Agents…">
        {definitions.length === 0 && !loading ? (
          <Empty description="No Agent definitions are registered." />
        ) : (
          <Space direction="vertical" size={12} className="agent-settings-list">
            {definitions.map((definition) => (
              <Card key={definition.id} title={definition.name} extra={<Tag>{definition.id}</Tag>}>
                <Space direction="vertical" size={8}>
                  <Typography.Text>
                    Executable:{' '}
                    <Typography.Text code>{definition.executable.command}</Typography.Text>
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    Permission enforcement: {definition.permissionEnforcement}
                  </Typography.Text>
                  <Space size={[6, 6]} wrap>
                    {definition.routing?.strengths?.map((strength) => (
                      <Tag color="blue" key={strength}>
                        {strength}
                      </Tag>
                    ))}
                  </Space>
                </Space>
              </Card>
            ))}
          </Space>
        )}
      </Spin>
    </Space>
  )
}
