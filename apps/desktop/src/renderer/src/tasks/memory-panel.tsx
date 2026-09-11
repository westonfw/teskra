import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import { Button, Card, Empty, Input, List, Modal, Popconfirm, Select, Space, Spin, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'

import { MEMORY_TYPES, type Memory, type MemoryType } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { isRepoLocalMemory, useMemoryStore } from '../stores/memory-store'

/**
 * MemoryPanel (TASK-067) — Workspace Memory CRUD UI.
 *
 * Database memories are editable; repo-local records merged from
 * `<repo>/.teskra/memory/*.md` carry a `repo` tag and are read-only (edit the
 * markdown file and commit it instead).
 */

const typeColor: Record<MemoryType, string> = {
  architecture: 'geekblue',
  convention: 'purple',
  decision: 'gold',
  command: 'cyan',
  known_issue: 'red',
  preference: 'magenta',
  summary: 'default',
}

type EditorState = { readonly mode: 'add' } | { readonly mode: 'edit'; readonly memory: Memory }

interface MemoryPanelProps {
  readonly workspaceId: string
}

export function MemoryPanel({ workspaceId }: MemoryPanelProps) {
  const memories = useMemoryStore((state) => state.memories)
  const loading = useMemoryStore((state) => state.loading)
  const saving = useMemoryStore((state) => state.saving)
  const error = useMemoryStore((state) => state.error)
  const synchronize = useMemoryStore((state) => state.synchronize)
  const create = useMemoryStore((state) => state.create)
  const update = useMemoryStore((state) => state.update)
  const remove = useMemoryStore((state) => state.remove)
  const clearError = useMemoryStore((state) => state.clearError)

  const [editor, setEditor] = useState<EditorState>()
  const [type, setType] = useState<MemoryType>('summary')
  const [content, setContent] = useState('')

  useEffect(() => {
    void synchronize(workspaceId)
  }, [synchronize, workspaceId])

  const openEditor = (next: EditorState): void => {
    setEditor(next)
    setType(next.mode === 'edit' ? next.memory.type : 'summary')
    setContent(next.mode === 'edit' ? next.memory.content : '')
  }

  const handleSave = async (): Promise<void> => {
    if (editor === undefined) return
    const trimmed = content.trim()
    const succeeded =
      editor.mode === 'add'
        ? await create({ workspaceId, type, content: trimmed })
        : await update({ id: editor.memory.id, type, content: trimmed })
    if (succeeded) setEditor(undefined)
  }

  return (
    <Card
      className="task-detail-card"
      title="Workspace Memory"
      extra={
        <Button
          size="small"
          icon={<PlusOutlined />}
          disabled={saving}
          onClick={() => openEditor({ mode: 'add' })}
        >
          Add memory
        </Button>
      }
    >
      {error !== undefined && (
        <AppErrorAlert className="page-alert" error={error} onClose={clearError} />
      )}
      <Spin spinning={loading}>
        <List
          size="small"
          dataSource={[...memories]}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No memories yet" /> }}
          renderItem={(memory) => {
            const readOnly = isRepoLocalMemory(memory)
            return (
              <List.Item
                actions={
                  readOnly
                    ? undefined
                    : [
                        <Button
                          key="edit"
                          type="text"
                          size="small"
                          icon={<EditOutlined />}
                          disabled={saving}
                          onClick={() => openEditor({ mode: 'edit', memory })}
                        />,
                        <Popconfirm
                          key="remove"
                          title="Delete this memory?"
                          onConfirm={() => void remove(memory.id)}
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
                }
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Tag color={typeColor[memory.type]}>{memory.type.replace('_', ' ')}</Tag>
                      {readOnly && <Tag>repo</Tag>}
                    </Space>
                  }
                  description={
                    <Typography.Paragraph
                      className="memory-content"
                      ellipsis={{ rows: 3, expandable: true, symbol: 'more' }}
                    >
                      {memory.content}
                    </Typography.Paragraph>
                  }
                />
              </List.Item>
            )
          }}
        />
      </Spin>

      <Modal
        title={editor?.mode === 'edit' ? 'Edit memory' : 'Add memory'}
        open={editor !== undefined}
        confirmLoading={saving}
        okButtonProps={{ disabled: content.trim().length === 0 }}
        onOk={() => void handleSave()}
        onCancel={() => setEditor(undefined)}
      >
        <Space direction="vertical" size={14} className="task-modal-fields">
          <label>
            <Typography.Text type="secondary">Type</Typography.Text>
            <Select<MemoryType>
              value={type}
              options={MEMORY_TYPES.map((value) => ({ value, label: value.replace('_', ' ') }))}
              onChange={setType}
            />
          </label>
          <label>
            <Typography.Text type="secondary">Content</Typography.Text>
            <Input.TextArea
              value={content}
              autoSize={{ minRows: 3, maxRows: 8 }}
              onChange={(event) => setContent(event.target.value)}
              placeholder="What should every Agent working in this workspace know?"
              autoFocus
            />
          </label>
        </Space>
      </Modal>
    </Card>
  )
}
