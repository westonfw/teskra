import { CheckCircleOutlined, ExclamationCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Empty, List, Space, Spin, Tag, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { DoctorCheck, DoctorReport, PublicAppError } from '@teskra/contracts'

import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
import { useWorkspaceStore } from '../stores/workspace-store'

const severityColor = { info: 'green', warning: 'gold', error: 'red' } as const

export function DoctorPage() {
  const { t } = useTranslation()
  const workspace = useWorkspaceStore((state) => state.current)
  const [report, setReport] = useState<DoctorReport>()
  const [error, setError] = useState<PublicAppError>()
  const [loading, setLoading] = useState(false)
  const tRef = useRef(t)
  tRef.current = t

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
        message: tRef.current('doctor.unreachable'),
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
          <Typography.Text className="settings-eyebrow">{t('doctor.eyebrow')}</Typography.Text>
          <Typography.Title level={2}>{t('doctor.title')}</Typography.Title>
          <Typography.Paragraph type="secondary">{t('doctor.subtitle')}</Typography.Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void runDoctor()}>
          {t('doctor.runAgain')}
        </Button>
      </header>

      {error !== undefined && (
        <AppErrorAlert className="page-alert" error={error} onClose={() => setError(undefined)} />
      )}

      <Spin spinning={loading} tip={t('doctor.running')}>
        {report === undefined ? (
          <Empty description={t('doctor.empty')} />
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
                  ? t('doctor.allHealthy')
                  : t('doctor.issuesFound', { count: report.issueCount })
              }
              description={
                workspace === undefined
                  ? t('doctor.generated', { time: new Date(report.generatedAt).toLocaleString() })
                  : t('doctor.generatedFor', {
                      time: new Date(report.generatedAt).toLocaleString(),
                      name: workspace.name,
                    })
              }
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
  const { t } = useTranslation()
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
              ? t('doctor.outcome.healthy')
              : check.outcome === 'skipped'
                ? t('doctor.outcome.skipped')
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
