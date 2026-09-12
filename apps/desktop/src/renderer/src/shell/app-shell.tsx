import {
  BranchesOutlined,
  CodeOutlined,
  ControlOutlined,
  FolderOutlined,
  GitlabOutlined,
  GlobalOutlined,
  HomeOutlined,
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
import { HomePage } from '../home/home-page'
import { RecoveryPage } from '../recovery/recovery-page'
import { TaskPage } from '../tasks/task-page'
import { AgentCatalogPage } from '../agents/agent-catalog-page'
import type { SettingsSectionRegistry } from '../settings/registry'
import { LOCALES, useTranslation, type Locale, type TranslationKey } from '../i18n'
import { useNavigationStore, type WorkbenchPage } from '../stores/navigation-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { TerminalKeepAliveHost } from '../terminal/terminal-keep-alive-host'
import { WorkspacePage } from '../workspace/workspace-page'

const navigation = [
  { key: 'home', labelKey: 'nav.home', icon: <HomeOutlined /> },
  { key: 'workspace', labelKey: 'nav.workspace', icon: <FolderOutlined /> },
  { key: 'tasks', labelKey: 'nav.tasks', icon: <ProjectOutlined /> },
  { key: 'runs', labelKey: 'nav.runs', icon: <PlayCircleOutlined /> },
  { key: 'git', labelKey: 'nav.git', icon: <GitlabOutlined /> },
  { key: 'terminal', labelKey: 'nav.terminal', icon: <CodeOutlined /> },
  { key: 'doctor', labelKey: 'nav.doctor', icon: <SafetyCertificateOutlined /> },
  { key: 'recovery', labelKey: 'nav.recovery', icon: <MedicineBoxOutlined /> },
  { key: 'settings', labelKey: 'nav.settings', icon: <SettingOutlined /> },
] satisfies ReadonlyArray<{
  key: WorkbenchPage
  labelKey: TranslationKey
  icon: React.ReactNode
}>

interface AppShellProps {
  readonly settingsRegistry: SettingsSectionRegistry
}

function runtimeLabel(kind: string, distro?: string): string {
  return kind === 'wsl' && distro !== undefined ? `WSL · ${distro}` : kind.toUpperCase()
}

function WorkspaceRequired({ feature }: { readonly feature: string }) {
  const navigate = useNavigationStore((state) => state.navigate)
  const { t } = useTranslation()
  return (
    <div className="workbench-page centered-empty">
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t('workspaceRequired.body', { feature })}
      >
        <Button type="primary" onClick={() => navigate('workspace')}>
          {t('workspaceRequired.action')}
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
  const { t, locale, setLocale } = useTranslation()

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
          items={navigation.map((item) => ({
            key: item.key,
            label: t(item.labelKey),
            icon: item.icon,
          }))}
          onSelect={({ key }) => navigate(key as WorkbenchPage)}
        />
        <div className="workbench-nav-footer">
          <ControlOutlined />
          <span>{t('app.tagline')}</span>
        </div>
      </Layout.Sider>

      <Layout className="workbench-main">
        <header className="workbench-topbar">
          <Select
            className="workspace-switcher"
            value={workspace?.id}
            placeholder={t('topbar.noWorkspace')}
            options={recent.map((item) => ({ value: item.id, label: item.name }))}
            onChange={selectWorkspace}
            suffixIcon={<FolderOutlined />}
          />
          <div className="topbar-context">
            <Space size={6}>
              <BranchesOutlined />
              <Typography.Text>{workspace?.defaultBranch ?? t('topbar.noBranch')}</Typography.Text>
            </Space>
            {workspace !== undefined && (
              <Tag bordered={false} color="cyan">
                {runtimeLabel(workspace.runtime.kind, workspace.runtime.distro)}
              </Tag>
            )}
            <Select<Locale>
              className="locale-switcher"
              size="small"
              variant="borderless"
              value={locale}
              suffixIcon={<GlobalOutlined />}
              options={LOCALES.map((value) => ({
                value,
                label: t(`app.language.${value}` as TranslationKey),
              }))}
              onChange={setLocale}
              aria-label={t('app.language')}
            />
          </div>
        </header>

        <main className="workbench-content">
          <div className={page === 'terminal' ? 'route-layer route-layer-hidden' : 'route-layer'}>
            {page === 'home' && <HomePage />}
            {page === 'workspace' && <WorkspacePage />}
            {page === 'tasks' && needsWorkspace(t('nav.tasks'), <TaskPage />)}
            {page === 'runs' && needsWorkspace(t('nav.runs'), <AgentCatalogPage />)}
            {page === 'git' && needsWorkspace(t('nav.git'), <ChangesPage />)}
            {page === 'doctor' && <DoctorPage />}
            {page === 'recovery' && needsWorkspace(t('nav.recovery'), <RecoveryPage />)}
            {page === 'settings' && (
              <SettingsPage registry={settingsRegistry} workspaceId={workspace?.id} />
            )}
          </div>

          {workspace === undefined ? (
            page === 'terminal' && <WorkspaceRequired feature={t('nav.terminal')} />
          ) : (
            <TerminalKeepAliveHost workspace={workspace} visible={page === 'terminal'} />
          )}
        </main>
      </Layout>
    </Layout>
  )
}
