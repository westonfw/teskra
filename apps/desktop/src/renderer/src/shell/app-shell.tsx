import {
  BranchesOutlined,
  CodeOutlined,
  ControlOutlined,
  FolderOutlined,
  GitlabOutlined,
  MedicineBoxOutlined,
  PlayCircleOutlined,
  ProjectOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { Button, Empty, Layout, Menu, Select, Space, Tag, Typography } from 'antd'
import { useEffect } from 'react'

import { SettingsPage } from '../settings/settings-page'
import { ChangesPage } from '../git/changes-page'
import { DoctorPage } from '../doctor/doctor-page'
import { RecoveryPage } from '../recovery/recovery-page'
import { TaskPage } from '../tasks/task-page'
import { AgentCatalogPage } from '../agents/agent-catalog-page'
import type { SettingsSectionRegistry } from '../settings/registry'
import { useNavigationStore, type WorkbenchPage } from '../stores/navigation-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { TerminalKeepAliveHost } from '../terminal/terminal-keep-alive-host'
import { WorkspacePage } from '../workspace/workspace-page'

const navigation = [
  { key: 'workspace', label: 'Workspace', icon: <FolderOutlined /> },
  { key: 'tasks', label: 'Tasks', icon: <ProjectOutlined /> },
  { key: 'runs', label: 'Runs', icon: <PlayCircleOutlined /> },
  { key: 'git', label: 'Git', icon: <GitlabOutlined /> },
  { key: 'terminal', label: 'Terminal', icon: <CodeOutlined /> },
  { key: 'doctor', label: 'Doctor', icon: <SafetyCertificateOutlined /> },
  { key: 'recovery', label: 'Recovery', icon: <MedicineBoxOutlined /> },
  { key: 'settings', label: 'Settings', icon: <SettingOutlined /> },
] satisfies ReadonlyArray<{ key: WorkbenchPage; label: string; icon: React.ReactNode }>

interface AppShellProps {
  readonly settingsRegistry: SettingsSectionRegistry
}

function runtimeLabel(kind: string, distro?: string): string {
  return kind === 'wsl' && distro !== undefined ? `WSL · ${distro}` : kind.toUpperCase()
}

function WorkspaceRequired({ feature }: { readonly feature: string }) {
  const navigate = useNavigationStore((state) => state.navigate)
  return (
    <div className="workbench-page centered-empty">
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={`Open a workspace before using ${feature}.`}
      >
        <Button type="primary" onClick={() => navigate('workspace')}>
          Choose workspace
        </Button>
      </Empty>
    </div>
  )
}

export function AppShell({ settingsRegistry }: AppShellProps) {
  const page = useNavigationStore((state) => state.page)
  const navigate = useNavigationStore((state) => state.navigate)
  const recent = useWorkspaceStore((state) => state.recent)
  const workspace = useWorkspaceStore((state) => state.current)
  const loadRecent = useWorkspaceStore((state) => state.loadRecent)
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace)

  useEffect(() => {
    void loadRecent()
  }, [loadRecent])

  const needsWorkspace = (feature: string, content: React.ReactNode): React.ReactNode =>
    workspace === undefined ? <WorkspaceRequired feature={feature} /> : content

  return (
    <Layout className="workbench-shell">
      <Layout.Sider width={214} className="workbench-nav">
        <div className="workbench-logo">
          <span className="settings-brand-mark">T</span>
          <div>
            <Typography.Title level={4}>Teskra</Typography.Title>
            <Typography.Text type="secondary">Workbench</Typography.Text>
          </div>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[page]}
          items={navigation}
          onSelect={({ key }) => navigate(key as WorkbenchPage)}
        />
        <div className="workbench-nav-footer">
          <ControlOutlined />
          <span>Orchestrate your coding agents.</span>
        </div>
      </Layout.Sider>

      <Layout className="workbench-main">
        <header className="workbench-topbar">
          <Select
            className="workspace-switcher"
            value={workspace?.id}
            placeholder="No workspace"
            options={recent.map((item) => ({ value: item.id, label: item.name }))}
            onChange={selectWorkspace}
            suffixIcon={<FolderOutlined />}
          />
          <div className="topbar-context">
            <Space size={6}>
              <BranchesOutlined />
              <Typography.Text>{workspace?.defaultBranch ?? 'No branch'}</Typography.Text>
            </Space>
            {workspace !== undefined && (
              <Tag bordered={false} color="cyan">
                {runtimeLabel(workspace.runtime.kind, workspace.runtime.distro)}
              </Tag>
            )}
          </div>
        </header>

        <main className="workbench-content">
          <div className={page === 'terminal' ? 'route-layer route-layer-hidden' : 'route-layer'}>
            {page === 'workspace' && <WorkspacePage />}
            {page === 'tasks' && needsWorkspace('Tasks', <TaskPage />)}
            {page === 'runs' && needsWorkspace('Runs', <AgentCatalogPage />)}
            {page === 'git' && needsWorkspace('Git', <ChangesPage />)}
            {page === 'doctor' && <DoctorPage />}
            {page === 'recovery' && needsWorkspace('Recovery Center', <RecoveryPage />)}
            {page === 'settings' && (
              <SettingsPage registry={settingsRegistry} workspaceId={workspace?.id} />
            )}
          </div>

          {workspace === undefined ? (
            page === 'terminal' && <WorkspaceRequired feature="Terminal" />
          ) : (
            <TerminalKeepAliveHost workspace={workspace} visible={page === 'terminal'} />
          )}
        </main>
      </Layout>
    </Layout>
  )
}
