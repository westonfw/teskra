import { Card, Empty, Space, Spin, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'

import { AppErrorAlert } from '../components/app-error-alert'
import { agentRuntimeKey, useAgentStore } from '../stores/agent-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { AgentPicker } from './agent-picker'

export function AgentCatalogPage() {
  const definitions = useAgentStore((state) => state.definitions)
  const loading = useAgentStore((state) => state.loading)
  const error = useAgentStore((state) => state.error)
  const health = useAgentStore((state) => state.health)
  const loadDefinitions = useAgentStore((state) => state.loadDefinitions)
  const loadHealth = useAgentStore((state) => state.loadHealth)
  const clearError = useAgentStore((state) => state.clearError)
  const [selectedId, setSelectedId] = useState<string>()
  const runtime = useWorkspaceStore((state) => state.current?.runtime)

  useEffect(() => {
    void loadDefinitions()
  }, [loadDefinitions])

  useEffect(() => {
    if (runtime !== undefined) void loadHealth(runtime)
  }, [loadHealth, runtime])

  useEffect(() => {
    if (selectedId === undefined && definitions[0] !== undefined) {
      setSelectedId(definitions[0].id)
    }
  }, [definitions, selectedId])

  return (
    <div className="workbench-page agent-catalog-page">
      <header className="page-heading">
        <div>
          <Typography.Text className="settings-eyebrow">AGENT REGISTRY</Typography.Text>
          <Typography.Title level={2}>Coding Agents</Typography.Title>
          <Typography.Paragraph type="secondary">
            Available integrations are discovered from the runtime Registry.
          </Typography.Paragraph>
        </div>
        <AgentPicker
          definitions={definitions}
          value={selectedId}
          onChange={setSelectedId}
          disabled={loading}
        />
      </header>

      {error !== undefined && (
        <AppErrorAlert className="page-alert" error={error} onClose={clearError} />
      )}
      <Spin spinning={loading} tip="Loading Agents…">
        {definitions.length === 0 && !loading ? (
          <Empty description="No Agent definitions are registered." />
        ) : (
          <div className="agent-card-grid">
            {definitions.map((definition) => {
              const status =
                runtime === undefined ? undefined : health[agentRuntimeKey(definition.id, runtime)]
              return (
                <Card
                  key={definition.id}
                  className={
                    definition.id === selectedId ? 'agent-card agent-card-selected' : 'agent-card'
                  }
                  title={definition.name}
                  extra={
                    <Space size={6}>
                      <Tag>{definition.id}</Tag>
                      {status !== undefined && (
                        <Tag color={status.available ? 'green' : 'red'}>
                          {status.available
                            ? 'Available'
                            : status.installed
                              ? 'Unavailable'
                              : 'Not installed'}
                        </Tag>
                      )}
                    </Space>
                  }
                  onClick={() => setSelectedId(definition.id)}
                >
                  <Space direction="vertical" size={12}>
                    <Typography.Text type="secondary">
                      {definition.routing?.useWhen ?? 'General coding Agent'}
                    </Typography.Text>
                    <Space size={[6, 6]} wrap>
                      {Object.entries(definition.capabilities)
                        .filter(([, enabled]) => enabled)
                        .map(([capability]) => (
                          <Tag color="cyan" key={capability}>
                            {capability}
                          </Tag>
                        ))}
                    </Space>
                    <Typography.Text code>{definition.executable.command}</Typography.Text>
                    {status?.version !== undefined && (
                      <Typography.Text type="secondary">{status.version}</Typography.Text>
                    )}
                  </Space>
                </Card>
              )
            })}
          </div>
        )}
      </Spin>
    </div>
  )
}
