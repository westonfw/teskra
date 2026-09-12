import { CheckOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import {
  Button,
  Card,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from 'antd'
import { useEffect, useState } from 'react'

import {
  CRITERION_CATEGORIES,
  type AcceptanceCriterion,
  type CriteriaReviewOutcome,
  type CriteriaSetStatus,
  type CriterionCategory,
  type CriterionResult,
} from '@teskra/contracts'
import { computeCriteriaReviewOutcome } from '@teskra/shared'

import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
import {
  editableCriteriaDetail,
  isCriteriaSetEditable,
  useCriteriaStore,
} from '../stores/criteria-store'
import { latestScoresByCriterion, useReviewStore } from '../stores/review-store'

/**
 * CriteriaPanel (TASK-049) — full Acceptance Criteria editing UI.
 *
 * Draft sets are editable (add / edit / remove / confirm); confirming freezes
 * the version. Confirmed sets are read-only and offer "New version to edit",
 * which creates a draft copy of their content (the confirmed set stays
 * immutable; the old confirmed set is superseded once the new draft is
 * confirmed).
 */

const statusColor: Record<CriteriaSetStatus, string> = {
  draft: 'default',
  confirmed: 'green',
  superseded: 'orange',
}

/** TASK-054: per-criterion review score and overall outcome tag colors. */
const scoreColor: Record<CriterionResult, string> = {
  pass: 'green',
  fail: 'red',
  unknown: 'default',
}

const outcomeColor: Record<CriteriaReviewOutcome, string> = {
  pass: 'green',
  fail: 'red',
  unknown: 'gold',
}

type EditorState =
  { readonly mode: 'add' } | { readonly mode: 'edit'; readonly criterion: AcceptanceCriterion }

interface CriteriaPanelProps {
  readonly taskId: string
}

export function CriteriaPanel({ taskId }: CriteriaPanelProps) {
  const details = useCriteriaStore((state) => state.details)
  const loading = useCriteriaStore((state) => state.loading)
  const saving = useCriteriaStore((state) => state.saving)
  const error = useCriteriaStore((state) => state.error)
  const startSynchronization = useCriteriaStore((state) => state.startSynchronization)
  const createDraftSet = useCriteriaStore((state) => state.createDraftSet)
  const addCriterion = useCriteriaStore((state) => state.addCriterion)
  const updateCriterion = useCriteriaStore((state) => state.updateCriterion)
  const removeCriterion = useCriteriaStore((state) => state.removeCriterion)
  const confirmSet = useCriteriaStore((state) => state.confirmSet)
  const clearError = useCriteriaStore((state) => state.clearError)
  const scores = useReviewStore((state) => state.scores)
  const startScoreSynchronization = useReviewStore((state) => state.startScoreSynchronization)
  const { t } = useTranslation()

  const [selectedSetId, setSelectedSetId] = useState<string>()
  const [editor, setEditor] = useState<EditorState>()
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<CriterionCategory>()
  const [required, setRequired] = useState(true)

  useEffect(() => startSynchronization(taskId), [startSynchronization, taskId])
  useEffect(() => startScoreSynchronization(taskId), [startScoreSynchronization, taskId])

  const selected =
    details.find(({ set }) => set.id === selectedSetId) ??
    editableCriteriaDetail(details) ??
    details[0]
  const editable = selected !== undefined && isCriteriaSetEditable(selected.set)
  // TASK-054: latest review score per criterion plus the derived overall
  // outcome (unknown never auto-passes; a required fail fails the review).
  const latestScores = latestScoresByCriterion(scores)
  const reviewed = (selected?.criteria ?? []).some((criterion) => latestScores.has(criterion.id))
  const overall =
    selected === undefined || selected.criteria.length === 0 || !reviewed
      ? undefined
      : computeCriteriaReviewOutcome(selected.criteria, [...latestScores.values()])

  const openEditor = (next: EditorState): void => {
    setEditor(next)
    setDescription(next.mode === 'edit' ? next.criterion.description : '')
    setCategory(next.mode === 'edit' ? next.criterion.category : undefined)
    setRequired(next.mode === 'edit' ? next.criterion.required : true)
  }

  const handleSave = async (): Promise<void> => {
    if (editor === undefined || selected === undefined) return
    const trimmed = description.trim()
    const succeeded =
      editor.mode === 'add'
        ? await addCriterion({
            setId: selected.set.id,
            description: trimmed,
            ...(category === undefined ? {} : { category }),
            required,
          })
        : await updateCriterion({
            criterionId: editor.criterion.id,
            description: trimmed,
            category: category ?? null,
            required,
          })
    if (succeeded) setEditor(undefined)
  }

  const handleConfirm = (setId: string): void => {
    Modal.confirm({
      title: t('criteria.confirmVersion.title'),
      content: t('criteria.confirmVersion.body'),
      okText: t('criteria.confirmVersion.ok'),
      onOk: () => confirmSet(setId),
    })
  }

  return (
    <Card
      className="task-detail-card"
      title={t('criteria.title')}
      extra={
        details.length > 1 && (
          <Select
            size="small"
            value={selected?.set.id}
            options={details.map(({ set }) => ({
              value: set.id,
              label: `v${set.version} · ${t(`criteria.status.${set.status}`)}`,
            }))}
            onChange={setSelectedSetId}
          />
        )
      }
    >
      {error !== undefined && (
        <AppErrorAlert className="page-alert" error={error} onClose={clearError} />
      )}
      <Spin spinning={loading}>
        {selected === undefined ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('criteria.empty')}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              loading={saving}
              onClick={() => void createDraftSet(taskId)}
            >
              {t('criteria.create')}
            </Button>
          </Empty>
        ) : (
          <div className="criteria-set">
            <Space wrap>
              <Typography.Text strong>v{selected.set.version}</Typography.Text>
              <Tag color={statusColor[selected.set.status]}>
                {t(`criteria.status.${selected.set.status}`)}
              </Tag>
              {overall !== undefined && (
                <Tag color={outcomeColor[overall]}>
                  {t('criteria.reviewOutcome', { outcome: overall })}
                </Tag>
              )}
              {selected.set.confirmedAt !== undefined && (
                <Typography.Text type="secondary">
                  {t('criteria.confirmedAt', {
                    time: new Date(selected.set.confirmedAt).toLocaleString(),
                  })}
                </Typography.Text>
              )}
              {editable ? (
                <>
                  <Button
                    size="small"
                    icon={<PlusOutlined />}
                    disabled={saving}
                    onClick={() => openEditor({ mode: 'add' })}
                  >
                    {t('criteria.add')}
                  </Button>
                  <Button
                    size="small"
                    type="primary"
                    icon={<CheckOutlined />}
                    disabled={saving || selected.criteria.length === 0}
                    onClick={() => handleConfirm(selected.set.id)}
                  >
                    {t('criteria.confirmVersion.button')}
                  </Button>
                </>
              ) : (
                selected.set.status === 'confirmed' && (
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    loading={saving}
                    onClick={() => void createDraftSet(taskId, selected.set.id)}
                  >
                    {t('criteria.newVersion')}
                  </Button>
                )
              )}
            </Space>
            {!editable && (
              <Typography.Paragraph type="secondary" className="criteria-readonly-note">
                {t('criteria.readonlyNote')}
              </Typography.Paragraph>
            )}
            <List
              size="small"
              dataSource={selected.criteria}
              locale={{ emptyText: t('criteria.emptyVersion') }}
              renderItem={(criterion) => (
                <List.Item
                  {...(editable
                    ? {
                        actions: [
                          <Button
                            key="edit"
                            type="text"
                            size="small"
                            icon={<EditOutlined />}
                            disabled={saving}
                            onClick={() => openEditor({ mode: 'edit', criterion })}
                          />,
                          <Popconfirm
                            key="remove"
                            title={t('criteria.removeConfirm')}
                            onConfirm={() => void removeCriterion(criterion.id)}
                          >
                            <Button
                              type="text"
                              size="small"
                              danger
                              icon={<DeleteOutlined />}
                              disabled={saving}
                            />
                          </Popconfirm>,
                        ],
                      }
                    : {})}
                >
                  <Space>
                    <Typography.Text>
                      #{criterion.ordinal} {criterion.description}
                    </Typography.Text>
                    {criterion.category !== undefined && (
                      <Tag>{t(`criteria.category.${criterion.category}`)}</Tag>
                    )}
                    {criterion.required && <Tag color="red">{t('criteria.required')}</Tag>}
                    {latestScores.has(criterion.id) && (
                      <Tag color={scoreColor[latestScores.get(criterion.id)?.result ?? 'unknown']}>
                        {latestScores.get(criterion.id)?.result}
                      </Tag>
                    )}
                  </Space>
                </List.Item>
              )}
            />
          </div>
        )}
      </Spin>

      <Modal
        title={editor?.mode === 'edit' ? t('criteria.edit') : t('criteria.add')}
        open={editor !== undefined}
        confirmLoading={saving}
        okButtonProps={{ disabled: description.trim().length === 0 }}
        onOk={() => void handleSave()}
        onCancel={() => setEditor(undefined)}
      >
        <Space direction="vertical" size={14} className="task-modal-fields">
          <label>
            <Typography.Text type="secondary">{t('criteria.fieldDescription')}</Typography.Text>
            <Input.TextArea
              value={description}
              autoSize={{ minRows: 2, maxRows: 6 }}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t('criteria.descriptionPlaceholder')}
              autoFocus
            />
          </label>
          <label>
            <Typography.Text type="secondary">{t('criteria.fieldCategory')}</Typography.Text>
            <Select<CriterionCategory>
              {...(category === undefined ? {} : { value: category })}
              allowClear
              placeholder={t('criteria.categoryPlaceholder')}
              options={CRITERION_CATEGORIES.map((value) => ({
                value,
                label: t(`criteria.category.${value}`),
              }))}
              onChange={(value) => setCategory(value)}
            />
          </label>
          <label>
            <Typography.Text type="secondary">{t('criteria.fieldRequired')}</Typography.Text>
            <div>
              <Switch checked={required} onChange={setRequired} />
            </div>
          </label>
        </Space>
      </Modal>
    </Card>
  )
}
