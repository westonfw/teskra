import { FolderOpenOutlined } from '@ant-design/icons'
import { Alert, Button, Form, Input, Modal, Radio, Select, Space } from 'antd'
import { useEffect, useState } from 'react'

import type { RuntimeKind, WorkspaceRuntimeRef, WslDistribution } from '@teskra/contracts'

import { useWorkspaceStore } from '../stores/workspace-store'
import { detectWslDistributions } from './wsl-distributions'

interface WorkspaceFormValues {
  readonly name?: string
  readonly kind: Extract<RuntimeKind, 'windows' | 'wsl'>
  readonly distro?: string
  readonly path: string
}

interface WorkspaceDialogProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onOpened: () => void
}

export function WorkspaceDialog({ open, onClose, onOpened }: WorkspaceDialogProps) {
  const [form] = Form.useForm<WorkspaceFormValues>()
  const [distributions, setDistributions] = useState<readonly WslDistribution[]>([])
  const [detecting, setDetecting] = useState(false)
  const [detectionError, setDetectionError] = useState<string>()
  const loading = useWorkspaceStore((state) => state.loading)
  const openWorkspace = useWorkspaceStore((state) => state.openWorkspace)
  const selectDirectory = useWorkspaceStore((state) => state.selectDirectory)
  const kind = Form.useWatch('kind', form) ?? 'windows'

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setDetecting(true)
    setDetectionError(undefined)
    void detectWslDistributions(window.teskra.runtime).then((outcome) => {
      if (cancelled) return
      if (outcome.ok) setDistributions(outcome.distributions)
      else setDetectionError(outcome.message)
      setDetecting(false)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  const runtimeFor = (values: WorkspaceFormValues): WorkspaceRuntimeRef =>
    values.kind === 'wsl' ? { kind: 'wsl', distro: values.distro } : { kind: 'windows' }

  const submit = async (): Promise<void> => {
    const values = await form.validateFields()
    const workspace = await openWorkspace({
      name: values.name?.trim() || undefined,
      runtime: runtimeFor(values),
      path: values.path.trim(),
    })
    if (workspace !== undefined) {
      form.resetFields()
      onOpened()
      onClose()
    }
  }

  return (
    <Modal
      title="Open workspace"
      open={open}
      okText="Open workspace"
      confirmLoading={loading}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form<WorkspaceFormValues> form={form} layout="vertical" initialValues={{ kind: 'windows' }}>
        <Form.Item label="Environment" name="kind">
          <Radio.Group optionType="button" buttonStyle="solid">
            <Radio.Button value="windows">Windows</Radio.Button>
            <Radio.Button value="wsl">WSL</Radio.Button>
          </Radio.Group>
        </Form.Item>
        {kind === 'wsl' && detectionError !== undefined && (
          <Alert
            type="warning"
            showIcon
            message="WSL distributions could not be detected"
            description={detectionError}
          />
        )}
        {kind === 'wsl' && (
          <Form.Item
            label="WSL distribution"
            name="distro"
            rules={[{ required: true, message: 'Choose a WSL distribution.' }]}
          >
            <Select
              loading={detecting}
              placeholder="Select a distribution"
              options={distributions.map((distribution) => ({
                value: distribution.name,
                label: distribution.name,
              }))}
            />
          </Form.Item>
        )}
        <Form.Item
          label={kind === 'windows' ? 'Windows folder' : 'Linux path'}
          name="path"
          rules={[{ required: true, whitespace: true, message: 'Enter a workspace path.' }]}
          extra={
            kind === 'wsl'
              ? 'Use a path inside the selected distribution, for example /home/me/project.'
              : undefined
          }
        >
          <Space.Compact block>
            <Input placeholder={kind === 'windows' ? 'C:\\src\\project' : '/home/me/project'} />
            {kind === 'windows' && (
              <Button
                icon={<FolderOpenOutlined />}
                onClick={async () => {
                  const path = await selectDirectory({ kind: 'windows' })
                  if (path !== null) form.setFieldValue('path', path)
                }}
              >
                Browse
              </Button>
            )}
          </Space.Compact>
        </Form.Item>
        <Form.Item label="Display name" name="name" extra="Optional; defaults to the folder name.">
          <Input placeholder="My project" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
