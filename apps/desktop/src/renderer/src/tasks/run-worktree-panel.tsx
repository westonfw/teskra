import { DeleteOutlined, MergeOutlined, NodeExpandOutlined } from '@ant-design/icons'
import { Alert, App as AntApp, Button, Card, Space, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'

import type { AgentRun, PublicAppError, Workspace, Worktree } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
import { useNavigationStore } from '../stores/navigation-store'
import { useTerminalStore } from '../stores/terminal-store'

/**
 * RunWorktreePanel (TASK-046) — the minimal worktree merge UI.
 *
 * Shows the worktree attached to a Run inside the Run detail drawer: its
 * state, a "Merge into <base>" action, and — the acceptance criterion of
 * TASK-046 — when the worktree is in 'conflict' state, a visible Alert with
 * the preserved conflict file list and explicit next steps (open a terminal
 * in the worktree to resolve, retry the merge, or just close the drawer and
 * deal with it later). This is deliberately NOT a worktree management page.
 */

const stateColor: Partial<Record<Worktree['state'], string>> = {
  ready: 'blue',
  dirty: 'gold',
  conflict: 'red',
  merged: 'green',
  discarded: 'default',
  missing: 'orange',
  orphaned: 'orange',
}

/** Single-quote a path for POSIX shells (worktree paths are Teskra-generated). */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

interface RunWorktreePanelProps {
  readonly run: AgentRun
  readonly workspace: Workspace
}

export function RunWorktreePanel({ run, workspace }: RunWorktreePanelProps) {
  const worktreeId = run.worktreeId
  const [worktree, setWorktree] = useState<Worktree | null>()
  const [conflicts, setConflicts] = useState<readonly string[]>([])
  const [error, setError] = useState<PublicAppError>()
  const [merging, setMerging] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [openingTerminal, setOpeningTerminal] = useState(false)
  const { modal } = AntApp.useApp()
  const { t } = useTranslation()
  const createTerminal = useTerminalStore((state) => state.createTerminal)
  const navigate = useNavigationStore((state) => state.navigate)

  const load = useCallback(async () => {
    if (worktreeId === undefined) return
    const result = await window.teskra.worktree.list({ workspaceId: workspace.id })
    if (!result.ok) {
      setError(result.error)
      return
    }
    setWorktree(result.data.find((candidate) => candidate.id === worktreeId) ?? null)
  }, [worktreeId, workspace.id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (worktreeId === undefined) return
    const stopConflict = window.teskra.events.subscribe('worktree.merge_conflict', (payload) => {
      if (payload.worktreeId !== worktreeId) return
      setConflicts(payload.conflicts)
      void load()
    })
    const stopMerged = window.teskra.events.subscribe('worktree.merged', (payload) => {
      if (payload.worktreeId === worktreeId) void load()
    })
    return () => {
      stopConflict()
      stopMerged()
    }
  }, [worktreeId, load])

  if (worktreeId === undefined) return null

  const handleMerge = async (force?: boolean): Promise<void> => {
    setMerging(true)
    setError(undefined)
    try {
      const result = await window.teskra.worktree.merge({ worktreeId, force })
      if (!result.ok) {
        setError(result.error)
        return
      }
      if (result.data.outcome === 'conflict') setConflicts(result.data.conflicts ?? [])
      setWorktree(result.data.worktree)
    } finally {
      setMerging(false)
    }
  }

  // TASK-047: discard is destructive (uncommitted changes are thrown away),
  // so it goes through a confirmation dialog that passes confirm: true.
  const handleDiscard = (): void => {
    if (worktree === undefined || worktree === null) return
    const target = worktree
    modal.confirm({
      title: t('worktree.discardConfirm.title'),
      content: t('worktree.discardConfirm.body', { branch: target.branch }),
      okText: t('worktree.discard'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setDiscarding(true)
        setError(undefined)
        try {
          const result = await window.teskra.worktree.discard({
            worktreeId: target.id,
            confirm: true,
          })
          if (!result.ok) {
            setError(result.error)
            return
          }
          setWorktree(result.data)
        } finally {
          setDiscarding(false)
        }
      },
    })
  }

  const handleOpenTerminal = async (): Promise<void> => {
    if (worktree === undefined || worktree === null) return
    setOpeningTerminal(true)
    try {
      const session = await createTerminal({
        workspaceId: workspace.id,
        shell: workspace.runtime.kind === 'windows' ? 'powershell' : 'bash',
        title: t('worktree.terminalTitle', { branch: worktree.branch }),
      })
      if (session === undefined) return
      await window.teskra.terminal.write({
        terminalId: session.id,
        data: `cd ${shellQuote(worktree.path)}\n`,
      })
      navigate('terminal')
    } finally {
      setOpeningTerminal(false)
    }
  }

  return (
    <Card className="task-detail-card" size="small" title={t('worktree.title')}>
      {error !== undefined && (
        <AppErrorAlert className="page-alert" error={error} onClose={() => setError(undefined)} />
      )}
      {worktree === null ? (
        <Typography.Text type="secondary">{t('worktree.gone')}</Typography.Text>
      ) : (
        worktree !== undefined && (
          <Space direction="vertical" size={12} className="run-worktree-panel">
            <Space size={12} wrap>
              <Tag color={stateColor[worktree.state]}>{worktree.state.replaceAll('_', ' ')}</Tag>
              <Typography.Text code>{worktree.branch}</Typography.Text>
              <Typography.Text type="secondary">→ {worktree.baseBranch}</Typography.Text>
            </Space>

            {worktree.state === 'conflict' && (
              <Alert
                type="error"
                showIcon
                closable
                message={t('worktree.conflict.message')}
                description={
                  <div>
                    <div>{t('worktree.conflict.description')}</div>
                    {conflicts.length > 0 && (
                      <ul className="run-worktree-conflict-list">
                        {conflicts.map((path) => (
                          <li key={path}>
                            <Typography.Text code>{path}</Typography.Text>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                }
              />
            )}

            {worktree.state === 'merged' && (
              <Alert
                type="success"
                showIcon
                message={t('worktree.merged', {
                  base: worktree.baseBranch,
                  branch: worktree.branch,
                })}
              />
            )}

            <Space wrap>
              {(worktree.state === 'ready' ||
                worktree.state === 'dirty' ||
                worktree.state === 'conflict') && (
                <Button
                  type="primary"
                  icon={<MergeOutlined />}
                  loading={merging}
                  onClick={() => void handleMerge()}
                >
                  {worktree.state === 'conflict'
                    ? t('worktree.retryMerge')
                    : t('worktree.mergeInto', { base: worktree.baseBranch })}
                </Button>
              )}
              {error?.code === 'MERGE_BLOCKED' && (
                <Button danger loading={merging} onClick={() => void handleMerge(true)}>
                  {t('worktree.mergeForce')}
                </Button>
              )}
              {worktree.state === 'conflict' && (
                <Button
                  icon={<NodeExpandOutlined />}
                  loading={openingTerminal}
                  onClick={() => void handleOpenTerminal()}
                >
                  {t('worktree.openTerminal')}
                </Button>
              )}
              {worktree.state !== 'merged' && worktree.state !== 'discarded' && (
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  loading={discarding}
                  onClick={handleDiscard}
                >
                  {t('worktree.discard')}
                </Button>
              )}
            </Space>
          </Space>
        )
      )}
    </Card>
  )
}
