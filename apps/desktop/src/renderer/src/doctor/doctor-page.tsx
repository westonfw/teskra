import { CheckCircleOutlined, ExclamationCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, List, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'

import type { DoctorCheck, DoctorReport, PublicAppError } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useWorkspaceStore } from '../stores/workspace-store'

const severityColor = { info: 'green', warning: 'gold', error: 'red' } as const

export function DoctorPage() {
  const workspace = useWorkspaceStore((state) => state.current)
  const [report, setReport] = useState<DoctorReport>()
  const [error, setError] = useState<PublicAppError>()
  const [loading, setLoading] = useState(false)

  const runDoctor = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      const result = await window.teskra.runtime.doctor({ workspaceId: workspace?.id })
      if (result.ok) setReport(result.data)
      else setError(result.error)
    } catch {
      setError({
        code: 'UNKNOWN',
        message: 'Teskra could not reach DoctorService.',
        retryable: true,
      })
    } finally {
      setLoading(false)
    }
  }, [workspace?.id])

  useEffect(() => {
    void runDoctor()
  }, [runDoctor])

  return (
    <div className="workbench-page doctor-page">
      <header className="page-heading">
        <div>
          <Typography.Text className="settings-eyebrow">SYSTEM DIAGNOSTICS</Typography.Text>
          <Typography.Title level={2}>Doctor</Typography.Title>
          <Typography.Paragraph type="secondary">
            Inspect runtime prerequisites and persistent state without changing them.
          </Typography.Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void runDoctor()}>
          Run again
        </Button>
      </header>

      {error !== undefined && (
        <AppErrorAlert className="page-alert" error={error} onClose={() => setError(undefined)} />
      )}

      <Spin spinning={loading} tip="Running diagnostics…">
        {report === undefined ? (
          <Empty description="Run Doctor to generate a health report." />
        ) : (
          <Space direction="vertical" size={18} className="doctor-report">
            <Alert
              showIcon
              type={
                report.severity === 'error'
                  ? 'error'
                  : report.severity === 'warning'
                    ? 'warning'
                    : 'success'
              }
              message={
                report.issueCount === 0
                  ? 'All checked systems are healthy.'
                  : `${String(report.issueCount)} issue(s) found.`
              }
              description={`Generated ${new Date(report.generatedAt).toLocaleString()}${workspace === undefined ? '' : ` for ${workspace.name}`}`}
            />
            <List
              className="doctor-check-list"
              dataSource={report.checks}
              renderItem={(item) => <DoctorCheckItem check={item} />}
            />
          </Space>
        )}
      </Spin>
    </div>
  )
}

function DoctorCheckItem({ check }: { readonly check: DoctorCheck }) {
  const healthy = check.outcome === 'pass'
  return (
    <List.Item>
      <Card
        size="small"
        className="doctor-check-card"
        title={
          <Space>
            {healthy ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />}
            <span>{check.label}</span>
          </Space>
        }
        extra={
          <Tag color={check.outcome === 'skipped' ? 'default' : severityColor[check.severity]}>
            {check.outcome === 'pass'
              ? 'Healthy'
              : check.outcome === 'skipped'
                ? 'Skipped'
                : check.severity}
          </Tag>
        }
      >
        <Typography.Paragraph>{check.summary}</Typography.Paragraph>
        {check.detail !== undefined && (
          <Typography.Text type="secondary">{check.detail}</Typography.Text>
        )}
        {check.relatedIds !== undefined && (
          <Space size={[6, 6]} wrap className="doctor-related-ids">
            {check.relatedIds.map((id) => (
              <Typography.Text code key={id}>
                {id}
              </Typography.Text>
            ))}
          </Space>
        )}
      </Card>
    </List.Item>
  )
}
