import { Button, Card, Empty, Input, Space, Spin, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'

import type { AgentDefinition, WorkspaceRuntimeRef } from '@teskra/contracts'

import { AppErrorAlert } from '../../components/app-error-alert'
import { useTranslation } from '../../i18n'
import { permissionEnforcementInfo } from '../../permissions/permission-view-model'
import { agentRuntimeKey, useAgentStore } from '../../stores/agent-store'
import { useWorkspaceStore } from '../../stores/workspace-store'

interface RuntimeExecutableControlProps {
  readonly definition: AgentDefinition
  readonly runtime: WorkspaceRuntimeRef
  readonly label: string
}

function RuntimeExecutableControl({ definition, runtime, label }: RuntimeExecutableControlProps) {
  const key = agentRuntimeKey(definition.id, runtime)
  const storedPath = useAgentStore((state) => state.executableOverrides[key])
  const detection = useAgentStore((state) => state.detections[key])
  const loadOverride = useAgentStore((state) => state.loadExecutableOverride)
  const saveOverride = useAgentStore((state) => state.setExecutableOverride)
  const detect = useAgentStore((state) => state.detect)
  const [path, setPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [detecting, setDetecting] = useState(false)

  useEffect(() => {
    void loadOverride(definition.id, runtime)
  }, [definition.id, key, loadOverride])

  useEffect(() => {
    if (storedPath !== undefined) setPath(storedPath ?? '')
  }, [storedPath])

  const save = async (): Promise<void> => {
    setSaving(true)
    await saveOverride(definition.id, runtime, path.trim().length === 0 ? null : path.trim())
    setSaving(false)
  }

  const check = async (): Promise<void> => {
    setDetecting(true)
    await detect(definition.id, runtime)
    setDetecting(false)
  }

  return (
    <div className="agent-runtime-control">
      <div className="agent-runtime-control-heading">
        <Typography.Text strong>{label}</Typography.Text>
        {detection === undefined ? (
          <Tag>Not checked</Tag>
        ) : (
          <Tag color={detection.installed ? 'green' : 'red'}>
            {detection.installed ? (detection.version ?? 'Installed') : 'Not installed'}
          </Tag>
        )}
      </div>
      <Space.Compact block>
        <Input
          value={path}
          placeholder={`Auto-detect ${definition.executable.command}`}
          onChange={(event) => setPath(event.target.value)}
        />
        <Button loading={saving} onClick={() => void save()}>
          Save
        </Button>
        <Button loading={detecting} onClick={() => void check()}>
          Detect
        </Button>
      </Space.Compact>
      {detection?.executable !== undefined && (
        <Typography.Text type="secondary" className="agent-detection-path">
          {detection.executable}
        </Typography.Text>
      )}
    </div>
  )
}

export function AgentsSettingsSection() {
  const definitions = useAgentStore((state) => state.definitions)
  const loading = useAgentStore((state) => state.loading)
  const error = useAgentStore((state) => state.error)
  const loadDefinitions = useAgentStore((state) => state.loadDefinitions)
  const clearError = useAgentStore((state) => state.clearError)
  const workspaceRuntime = useWorkspaceStore((state) => state.current?.runtime)
  const { t } = useTranslation()
  const wslRuntime: WorkspaceRuntimeRef = {
    kind: 'wsl',
    ...(workspaceRuntime?.kind === 'wsl' && workspaceRuntime.distro !== undefined
      ? { distro: workspaceRuntime.distro }
      : {}),
  }

  useEffect(() => {
    void loadDefinitions()
  }, [loadDefinitions])

  return (
    <Space direction="vertical" size={18} className="settings-section-stack">
      <div>
        <Typography.Text className="settings-eyebrow">REGISTRY</Typography.Text>
        <Typography.Title level={3}>Coding Agents</Typography.Title>
        <Typography.Paragraph type="secondary">
          Agent entries come from the Main-process Registry. Executable overrides are
          machine-specific and always stored in global config.
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
                    Permission enforcement:{' '}
                    {permissionEnforcementInfo(definition.permissionEnforcement, t).label} (
                    {definition.permissionEnforcement}) —{' '}
                    {permissionEnforcementInfo(definition.permissionEnforcement, t).description}
                  </Typography.Text>
                  <Space size={[6, 6]} wrap>
                    {definition.routing?.strengths?.map((strength) => (
                      <Tag color="blue" key={strength}>
                        {strength}
                      </Tag>
                    ))}
                  </Space>
                  <RuntimeExecutableControl
                    definition={definition}
                    runtime={{ kind: 'windows' }}
                    label="Windows"
                  />
                  <RuntimeExecutableControl
                    definition={definition}
                    runtime={wslRuntime}
                    label={wslRuntime.distro === undefined ? 'WSL' : `WSL · ${wslRuntime.distro}`}
                  />
                </Space>
              </Card>
            ))}
          </Space>
        )}
      </Spin>
    </Space>
  )
}
