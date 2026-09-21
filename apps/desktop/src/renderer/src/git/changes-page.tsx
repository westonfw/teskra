import { FileOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons'
import { Button, Card, Empty, Space, Spin, Tag, Typography } from 'antd'
import { useEffect, useMemo } from 'react'

import type { DiffFileStatus, DiffFileSummary, PublicAppError } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
import { useGitStore } from '../stores/git-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import { splitDiffLines } from './diff-lines'

const MAX_RENDERED_PATCH_CHARS = 200_000
const MAX_VISIBLE_CHANGE_FILES = 500

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

function filesForDisplay(files: readonly DiffFileSummary[]): readonly DiffFileSummary[] {
  return files.slice(0, MAX_VISIBLE_CHANGE_FILES)
}

/**
 * A not-a-repository error swaps the whole changes workbench for the guided
 * git-init empty state; every other error keeps the AppErrorAlert.
 */
function isNotARepositoryError(error: PublicAppError | undefined): boolean {
  return error?.code === 'GIT_NOT_A_REPOSITORY'
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  readonly file: DiffFileSummary
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
  const { t } = useTranslation()
  const workspace = useWorkspaceStore((state) => state.current)
  const status = useGitStore((state) => state.status)
  const changes = useGitStore((state) => state.changes)
  const patches = useGitStore((state) => state.patches)
  const patchLoading = useGitStore((state) => state.patchLoading)
  const selectedPath = useGitStore((state) => state.selectedPath)
  const loading = useGitStore((state) => state.loading)
  const initializing = useGitStore((state) => state.initializing)
  const error = useGitStore((state) => state.error)
  const startSynchronization = useGitStore((state) => state.startSynchronization)
  const refresh = useGitStore((state) => state.refresh)
  const refreshOnFocus = useGitStore((state) => state.refreshOnFocus)
  const selectFile = useGitStore((state) => state.selectFile)
  const loadPatch = useGitStore((state) => state.loadPatch)
  const initRepository = useGitStore((state) => state.initRepository)
  const openFile = useGitStore((state) => state.openFile)
  const clearError = useGitStore((state) => state.clearError)

  useEffect(() => {
    if (workspace === undefined) return
    return startSynchronization(workspace.id)
  }, [startSynchronization, workspace])

  useEffect(() => {
    if (workspace === undefined) return
    const handleFocus = () => refreshOnFocus(workspace.id)
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [refreshOnFocus, workspace])

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
  const visibleFiles = useMemo(() => filesForDisplay(changes.files), [changes.files])

  // Patches are lazy (P1-5): only the selected file's patch crosses IPC, and
  // the cache is keyed by `${workspaceId} ${path}` — never by path alone, so a
  // stale fetch from a previous workspace cannot show its diff here.
  // refresh() clears the cache while selectedPath may survive, so the cached
  // entry — not the path — must gate the fetch, or a refresh leaves the panel
  // permanently blank. refreshCount re-arms the effect after every refresh,
  // and patchFailed re-arms it when the user re-selects a file whose fetch
  // failed (loadPatch refuses auto-retries of marked failures).
  const selectedPatchKey =
    workspace === undefined || selectedPath === undefined
      ? undefined
      : `${workspace.id} ${selectedPath}`
  const selectedPatch = selectedPatchKey === undefined ? undefined : patches[selectedPatchKey]
  const refreshCount = useGitStore((state) => state.refreshCount)
  const patchFailed = useGitStore((state) =>
    selectedPatchKey === undefined ? false : state.patchFailures[selectedPatchKey] === true,
  )
  useEffect(() => {
    if (workspace === undefined || selectedPath === undefined) return
    if (selectedPatch !== undefined) return
    void loadPatch(workspace.id, selectedPath)
  }, [loadPatch, selectedPath, selectedPatch, patchFailed, refreshCount, workspace])

  const displayPatch = patchForDisplay(
    selected === undefined || selectedPatchKey === undefined
      ? ''
      : (patches[selectedPatchKey] ?? ''),
  )
  const diffLines = useMemo(() => splitDiffLines(displayPatch.text), [displayPatch.text])

  if (workspace === undefined) return null

  const notARepository = isNotARepositoryError(error)

  return (
    <div className="workbench-page changes-page">
      <div className="page-heading changes-heading">
        <div>
          <Typography.Text className="settings-eyebrow">{t('git.eyebrow')}</Typography.Text>
          <Typography.Title level={2}>{t('git.title')}</Typography.Title>
          <Space size={12} wrap>
            <Typography.Text type="secondary">
              {t(changes.files.length === 1 ? 'git.filesChangedOne' : 'git.filesChangedMany', {
                count: changes.files.length,
              })}
            </Typography.Text>
            <Typography.Text className="diff-additions">+{totals.additions}</Typography.Text>
            <Typography.Text className="diff-deletions">−{totals.deletions}</Typography.Text>
            <Tag bordered={false}>{status?.branch ?? t('git.detachedHead')}</Tag>
            {(status?.ahead ?? 0) > 0 && <Tag color="cyan">↑ {status?.ahead}</Tag>}
            {(status?.behind ?? 0) > 0 && <Tag color="orange">↓ {status?.behind}</Tag>}
          </Space>
        </div>
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => void refresh(workspace.id)}
        >
          {t('home.refresh')}
        </Button>
      </div>

      {notARepository ? (
        <Card className="changes-empty" variant="borderless">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space direction="vertical" size={4}>
                <Typography.Text>{t('git.notARepository.title')}</Typography.Text>
                <Typography.Text type="secondary">{t('git.notARepository.body')}</Typography.Text>
              </Space>
            }
          >
            <Button
              type="primary"
              loading={initializing}
              onClick={() => void initRepository(workspace.id)}
            >
              {t('git.notARepository.action')}
            </Button>
          </Empty>
        </Card>
      ) : (
        <>
          {error !== undefined && (
            <AppErrorAlert error={error} onClose={clearError} className="page-alert" />
          )}

          <Spin spinning={loading && status === undefined}>
            {changes.files.length === 0 ? (
              <Card className="changes-empty" variant="borderless">
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('git.empty')} />
              </Card>
            ) : (
              <div className="changes-workbench">
                <Card
                  className="changes-file-card"
                  title={t('git.filesTitle')}
                  variant="borderless"
                >
                  {changes.files.length > MAX_VISIBLE_CHANGE_FILES && (
                    <div className="large-file-list-notice">
                      {t('git.largeFileListNotice', {
                        visible: MAX_VISIBLE_CHANGE_FILES.toLocaleString(),
                        total: changes.files.length.toLocaleString(),
                      })}
                    </div>
                  )}
                  <div className="changes-file-list">
                    {visibleFiles.map((file) => (
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
                  title={selected?.path ?? t('git.diffTitle')}
                  extra={
                    selected !== undefined && selected.status !== 'deleted' ? (
                      <Button
                        size="small"
                        icon={<FolderOpenOutlined />}
                        onClick={() => void openFile(workspace.id, selected.path)}
                      >
                        {t('git.openFile')}
                      </Button>
                    ) : undefined
                  }
                  variant="borderless"
                >
                  {displayPatch.truncated && (
                    <div className="large-diff-notice">
                      {t('git.largeDiffNotice', {
                        count: MAX_RENDERED_PATCH_CHARS.toLocaleString(),
                      })}
                    </div>
                  )}
                  <Spin
                    spinning={
                      patchLoading &&
                      selectedPatchKey !== undefined &&
                      patches[selectedPatchKey] === undefined
                    }
                  >
                    <pre className="diff-patch" tabIndex={0}>
                      {diffLines.map((line, index) => (
                        <span
                          key={`${index}:${line.text}`}
                          className={`diff-line diff-line-${line.kind}`}
                        >
                          {line.text}
                          {'\n'}
                        </span>
                      ))}
                    </pre>
                  </Spin>
                </Card>
              </div>
            )}
          </Spin>
        </>
      )}
    </div>
  )
}

export {
  MAX_RENDERED_PATCH_CHARS,
  MAX_VISIBLE_CHANGE_FILES,
  filesForDisplay,
  isNotARepositoryError,
  patchForDisplay,
}
