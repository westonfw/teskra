import { DeleteOutlined, FolderOpenOutlined, PlusOutlined } from '@ant-design/icons'
import { Button, Card, Empty, List, Popconfirm, Space, Tag, Typography } from 'antd'
import { useState } from 'react'

import { AppErrorAlert } from '../components/app-error-alert'
import { useNavigationStore } from '../stores/navigation-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { WorkspaceDialog } from './workspace-dialog'

export function WorkspacePage() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const recent = useWorkspaceStore((state) => state.recent)
  const current = useWorkspaceStore((state) => state.current)
  const loading = useWorkspaceStore((state) => state.loading)
  const error = useWorkspaceStore((state) => state.error)
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace)
  const removeWorkspace = useWorkspaceStore((state) => state.removeWorkspace)
  const clearError = useWorkspaceStore((state) => state.clearError)
  const navigate = useNavigationStore((state) => state.navigate)

  return (
    <div className="workbench-page workspace-page">
      <div className="page-heading">
        <div>
          <Typography.Text className="settings-eyebrow">WORKSPACES</Typography.Text>
          <Typography.Title level={2}>Choose where Agents work</Typography.Title>
          <Typography.Paragraph type="secondary">
            Windows and WSL projects stay isolated by an explicit runtime boundary.
          </Typography.Paragraph>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setDialogOpen(true)}>
          Open folder
        </Button>
      </div>

      {error !== undefined && (
        <AppErrorAlert error={error} onClose={clearError} className="page-alert" />
      )}

      {recent.length === 0 ? (
        <Card className="workspace-empty-card" variant="borderless">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space direction="vertical" size={4}>
                <Typography.Text strong>No workspace is open</Typography.Text>
                <Typography.Text type="secondary">
                  Open a Windows folder or connect a path inside WSL to begin.
                </Typography.Text>
              </Space>
            }
          >
            <Button
              type="primary"
              icon={<FolderOpenOutlined />}
              loading={loading}
              onClick={() => setDialogOpen(true)}
            >
              Open your first workspace
            </Button>
          </Empty>
        </Card>
      ) : (
        <Card title="Recent workspaces" variant="borderless">
          <List
            dataSource={[...recent]}
            renderItem={(workspace) => (
              <List.Item
                className={workspace.id === current?.id ? 'workspace-list-active' : undefined}
                actions={[
                  <Button
                    key="open"
                    type={workspace.id === current?.id ? 'primary' : 'default'}
                    onClick={() => {
                      selectWorkspace(workspace.id)
                      navigate('terminal')
                    }}
                  >
                    {workspace.id === current?.id ? 'Open terminal' : 'Switch'}
                  </Button>,
                  <Popconfirm
                    key="remove"
                    title="Remove this workspace from Teskra?"
                    description="The project files will not be deleted."
                    onConfirm={() => void removeWorkspace(workspace.id)}
                  >
                    <Button
                      danger
                      type="text"
                      icon={<DeleteOutlined />}
                      aria-label="Remove workspace"
                    />
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Typography.Text strong>{workspace.name}</Typography.Text>
                      <Tag bordered={false}>{workspace.runtime.kind.toUpperCase()}</Tag>
                    </Space>
                  }
                  description={workspace.path}
                />
              </List.Item>
            )}
          />
        </Card>
      )}

      <WorkspaceDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onOpened={() => navigate('terminal')}
      />
    </div>
  )
}
