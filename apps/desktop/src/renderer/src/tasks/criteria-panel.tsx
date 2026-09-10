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
  | { readonly mode: 'add' }
  | { readonly mode: 'edit'; readonly criterion: AcceptanceCriterion }

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
      title: 'Confirm this criteria version?',
      content:
        'A confirmed version is immutable. Any further change will require creating a new version, and the previously confirmed version will be superseded.',
      okText: 'Confirm',
      onOk: () => confirmSet(setId),
    })
  }

  return (
    <Card
      className="task-detail-card"
      title="Acceptance Criteria"
      extra={
        details.length > 1 && (
          <Select
            size="small"
            value={selected?.set.id}
            options={details.map(({ set }) => ({
              value: set.id,
              label: `v${set.version} · ${set.status}`,
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
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No acceptance criteria yet">
            <Button
              type="primary"
              icon={<PlusOutlined />}
              loading={saving}
              onClick={() => void createDraftSet(taskId)}
            >
              Create criteria
            </Button>
          </Empty>
        ) : (
          <div className="criteria-set">
            <Space wrap>
              <Typography.Text strong>v{selected.set.version}</Typography.Text>
              <Tag color={statusColor[selected.set.status]}>{selected.set.status}</Tag>
              {overall !== undefined && (
                <Tag color={outcomeColor[overall]}>{`review: ${overall}`}</Tag>
              )}
              {selected.set.confirmedAt !== undefined && (
                <Typography.Text type="secondary">
                  confirmed {new Date(selected.set.confirmedAt).toLocaleString()}
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
                    Add criterion
                  </Button>
                  <Button
                    size="small"
                    type="primary"
                    icon={<CheckOutlined />}
                    disabled={saving || selected.criteria.length === 0}
                    onClick={() => handleConfirm(selected.set.id)}
                  >
                    Confirm version
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
                    New version to edit
                  </Button>
                )
              )}
            </Space>
            {!editable && (
              <Typography.Paragraph type="secondary" className="criteria-readonly-note">
                This version is immutable and shown read-only.
              </Typography.Paragraph>
            )}
            <List
              size="small"
              dataSource={selected.criteria}
              locale={{ emptyText: 'No criteria in this version' }}
              renderItem={(criterion) => (
                <List.Item
                  actions={
                    editable
                      ? [
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
                            title="Remove this criterion?"
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
                        ]
                      : undefined
                  }
                >
                  <Space>
                    <Typography.Text>
                      #{criterion.ordinal} {criterion.description}
                    </Typography.Text>
                    {criterion.category !== undefined && <Tag>{criterion.category}</Tag>}
                    {criterion.required && <Tag color="red">required</Tag>}
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
        title={editor?.mode === 'edit' ? 'Edit criterion' : 'Add criterion'}
        open={editor !== undefined}
        confirmLoading={saving}
        okButtonProps={{ disabled: description.trim().length === 0 }}
        onOk={() => void handleSave()}
        onCancel={() => setEditor(undefined)}
      >
        <Space direction="vertical" size={14} className="task-modal-fields">
          <label>
            <Typography.Text type="secondary">Description</Typography.Text>
            <Input.TextArea
              value={description}
              autoSize={{ minRows: 2, maxRows: 6 }}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What must be true for this Task to be accepted?"
              autoFocus
            />
          </label>
          <label>
            <Typography.Text type="secondary">Category</Typography.Text>
            <Select<CriterionCategory>
              value={category}
              allowClear
              placeholder="Optional"
              options={CRITERION_CATEGORIES.map((value) => ({ value, label: value }))}
              onChange={(value) => setCategory(value)}
            />
          </label>
          <label>
            <Typography.Text type="secondary">Required</Typography.Text>
            <div>
              <Switch checked={required} onChange={setRequired} />
            </div>
          </label>
        </Space>
      </Modal>
    </Card>
  )
}
