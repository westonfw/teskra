import { CloseOutlined, PlusOutlined } from '@ant-design/icons'
import { Button, Empty, Select, Spin, Tabs } from 'antd'
import { useEffect, useState } from 'react'

import type { TerminalShell, Workspace } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useTerminalStore } from '../stores/terminal-store'
import { TerminalView } from './terminal-view'

interface TerminalKeepAliveHostProps {
  readonly workspace: Workspace
  /** Route changes hide this host with CSS; they never unmount its terminals. */
  readonly visible: boolean
}

export function TerminalKeepAliveHost({ workspace, visible }: TerminalKeepAliveHostProps) {
  const tabs = useTerminalStore((state) => state.tabs)
  const activeId = useTerminalStore((state) => state.activeId)
  const history = useTerminalStore((state) => state.history)
  const loading = useTerminalStore((state) => state.loading)
  const error = useTerminalStore((state) => state.error)
  const synchronize = useTerminalStore((state) => state.synchronize)
  const createTerminal = useTerminalStore((state) => state.createTerminal)
  const closeTerminal = useTerminalStore((state) => state.closeTerminal)
  const activate = useTerminalStore((state) => state.activate)
  const clearError = useTerminalStore((state) => state.clearError)
  const defaultShell: TerminalShell = workspace.runtime.kind === 'windows' ? 'powershell' : 'bash'
  const shells: readonly TerminalShell[] =
    workspace.runtime.kind === 'windows' ? ['powershell', 'cmd'] : ['bash', 'wsl']
  const [shell, setShell] = useState<TerminalShell>(defaultShell)

  useEffect(() => {
    void synchronize(workspace.id)
  }, [synchronize, workspace.id])

  useEffect(() => {
    setShell(defaultShell)
  }, [workspace.runtime.kind])

  const workspaceTabs = tabs.filter((tab) => tab.session.workspaceId === workspace.id)

  return (
    <section
      className={`terminal-keep-alive${visible ? ' terminal-keep-alive-visible' : ''}`}
      aria-hidden={!visible}
    >
      <div className="terminal-toolbar">
        <Select<TerminalShell>
          value={shell}
          options={shells.map((value) => ({ label: value, value }))}
          onChange={setShell}
        />
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => void createTerminal({ workspaceId: workspace.id, shell })}
        >
          New terminal
        </Button>
      </div>
      {error !== undefined && <AppErrorAlert error={error} onClose={clearError} />}
      <Spin spinning={loading}>
        {workspaceTabs.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No terminals in this workspace"
          />
        ) : (
          <Tabs
            className="terminal-tabs"
            activeKey={activeId}
            destroyOnHidden={false}
            onChange={activate}
            items={workspaceTabs.map((tab) => ({
              key: tab.session.id,
              label: (
                <span>
                  {tab.session.title}
                  {tab.status === 'closed' ? ' · exited' : ''}
                </span>
              ),
              forceRender: true,
              closeIcon: <CloseOutlined />,
              children: (
                <TerminalView
                  session={tab.session}
                  visible={visible && activeId === tab.session.id}
                  initialData={history[tab.session.id]}
                  readOnly={tab.status === 'closed'}
                />
              ),
            }))}
            type="editable-card"
            hideAdd
            onEdit={(key, action) => {
              if (action === 'remove') void closeTerminal(String(key))
            }}
          />
        )}
      </Spin>
    </section>
  )
}
