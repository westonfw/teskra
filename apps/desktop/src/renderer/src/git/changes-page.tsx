import { FileOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons'
import { Button, Card, Empty, Space, Spin, Tag, Typography } from 'antd'
import { useEffect, useMemo } from 'react'

import type { DiffFile, DiffFileStatus } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useGitStore } from '../stores/git-store'
import { useWorkspaceStore } from '../stores/workspace-store'

const MAX_RENDERED_PATCH_CHARS = 200_000

const statusColor: Record<DiffFileStatus, string> = {
  added: 'green',
  modified: 'blue',
  deleted: 'red',
  renamed: 'purple',
}

function patchForDisplay(patch: string): { text: string; truncated: boolean } {
  return patch.length > MAX_RENDERED_PATCH_CHARS
    ? { text: patch.slice(0, MAX_RENDERED_PATCH_CHARS), truncated: true }
    : { text: patch, truncated: false }
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  readonly file: DiffFile
  readonly selected: boolean
  readonly onSelect: () => void
}) {
  return (
    <button
      type="button"
      className={selected ? 'change-file-row change-file-row-selected' : 'change-file-row'}
      onClick={onSelect}
    >
      <FileOutlined />
      <span className="change-file-path" title={file.path}>
        {file.path}
      </span>
      <Tag bordered={false} color={statusColor[file.status]}>
        {file.status}
      </Tag>
      <span className="change-file-stats">
        <span className="diff-additions">+{file.additions}</span>
        <span className="diff-deletions">−{file.deletions}</span>
      </span>
    </button>
  )
}

export function ChangesPage() {
  const workspace = useWorkspaceStore((state) => state.current)
  const status = useGitStore((state) => state.status)
  const changes = useGitStore((state) => state.changes)
  const selectedPath = useGitStore((state) => state.selectedPath)
  const loading = useGitStore((state) => state.loading)
  const error = useGitStore((state) => state.error)
  const startSynchronization = useGitStore((state) => state.startSynchronization)
  const refresh = useGitStore((state) => state.refresh)
  const selectFile = useGitStore((state) => state.selectFile)
  const openFile = useGitStore((state) => state.openFile)
  const clearError = useGitStore((state) => state.clearError)

  useEffect(() => {
    if (workspace === undefined) return
    return startSynchronization(workspace.id)
  }, [startSynchronization, workspace])

  const totals = useMemo(
    () =>
      changes.files.reduce(
        (result, file) => ({
          additions: result.additions + file.additions,
          deletions: result.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [changes.files],
  )
  const selected = changes.files.find(({ path }) => path === selectedPath)
  const displayPatch = patchForDisplay(selected?.patch ?? '')

  if (workspace === undefined) return null

  return (
    <div className="workbench-page changes-page">
      <div className="page-heading changes-heading">
        <div>
          <Typography.Text className="settings-eyebrow">CHANGES</Typography.Text>
          <Typography.Title level={2}>Review repository changes</Typography.Title>
          <Space size={12} wrap>
            <Typography.Text type="secondary">
              {changes.files.length} {changes.files.length === 1 ? 'file' : 'files'} changed
            </Typography.Text>
            <Typography.Text className="diff-additions">+{totals.additions}</Typography.Text>
            <Typography.Text className="diff-deletions">−{totals.deletions}</Typography.Text>
            <Tag bordered={false}>{status?.branch ?? 'detached HEAD'}</Tag>
            {(status?.ahead ?? 0) > 0 && <Tag color="cyan">↑ {status?.ahead}</Tag>}
            {(status?.behind ?? 0) > 0 && <Tag color="orange">↓ {status?.behind}</Tag>}
          </Space>
        </div>
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => void refresh(workspace.id)}
        >
          Refresh
        </Button>
      </div>

      {error !== undefined && (
        <AppErrorAlert error={error} onClose={clearError} className="page-alert" />
      )}

      <Spin spinning={loading && status === undefined}>
        {changes.files.length === 0 ? (
          <Card className="changes-empty" variant="borderless">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Working tree is clean" />
          </Card>
        ) : (
          <div className="changes-workbench">
            <Card className="changes-file-card" title="Files" variant="borderless">
              <div className="changes-file-list">
                {changes.files.map((file) => (
                  <FileRow
                    key={file.path}
                    file={file}
                    selected={file.path === selectedPath}
                    onSelect={() => selectFile(file.path)}
                  />
                ))}
              </div>
            </Card>

            <Card
              className="changes-diff-card"
              title={selected?.path ?? 'Diff'}
              extra={
                selected !== undefined && selected.status !== 'deleted' ? (
                  <Button
                    size="small"
                    icon={<FolderOpenOutlined />}
                    onClick={() => void openFile(workspace.id, selected.path)}
                  >
                    Open file
                  </Button>
                ) : undefined
              }
              variant="borderless"
            >
              {displayPatch.truncated && (
                <div className="large-diff-notice">
                  Showing the first {MAX_RENDERED_PATCH_CHARS.toLocaleString()} characters to keep
                  the workbench responsive. Open the file for the complete content.
                </div>
              )}
              <pre className="diff-patch" tabIndex={0}>
                {displayPatch.text}
              </pre>
            </Card>
          </div>
        )}
      </Spin>
    </div>
  )
}

export { MAX_RENDERED_PATCH_CHARS, patchForDisplay }
