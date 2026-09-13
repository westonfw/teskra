import { Alert, Button, Drawer, Space, Typography } from 'antd'
import type { AgentRun } from '@teskra/contracts'
import { useState } from 'react'

import { LoginTerminalView } from '../accounts/login-terminal-view'
import { useAccountProfileStore } from '../accounts/account-profile-store'
import { useTranslation } from '../i18n'
import { useAgentStore } from '../stores/agent-store'
import { restartAgentRunRequest } from './agent-watchdog'
import { ContinueWithAccountModal } from './continue-with-account-modal'
import { useContinuationStore } from './continuation-store'

interface RateLimitAlertProps {
  readonly run: AgentRun
  /** Opens another run's detail view (used after a successful Retry/Continue). */
  readonly onOpenRun: (run: AgentRun) => void
}

/**
 * TASK-108 (Milestone 24 §26) — the failure-classification card on a run
 * detail. `rate-limited` gets the full treatment (reset time, evidence as
 * plain text per §17.3, Continue / Retry / Wait); authentication-required /
 * expired additionally offer a re-login entry that reuses the Settings →
 * Accounts login terminal.
 */
export function RateLimitAlert({ run, onOpenRun }: RateLimitAlertProps) {
  const classification = run.failureClassification
  const { t } = useTranslation()
  const startRun = useAgentStore((state) => state.startRun)
  const openContinuation = useContinuationStore((state) => state.openFor)
  const accountName = useAccountProfileStore(
    (state) => state.profiles.find((profile) => profile.id === run.accountProfileId)?.name,
  )
  const [retrying, setRetrying] = useState(false)
  const [dismissedFor, setDismissedFor] = useState<string>()
  const [relogin, setRelogin] = useState(false)

  if (classification === undefined || dismissedFor === run.id) return null

  const retry = async (): Promise<void> => {
    setRetrying(true)
    const restarted = await startRun(restartAgentRunRequest(run))
    setRetrying(false)
    if (restarted !== undefined) onOpenRun(restarted)
  }

  if (classification.kind === 'rate-limited') {
    return (
      <>
        <Alert
          type="warning"
          showIcon
          message={t('rateLimit.title')}
          description={
            <Space direction="vertical" size={4}>
              <Typography.Text type="secondary">
                {classification.resetAt === undefined
                  ? t('rateLimit.resetUnknown')
                  : t('rateLimit.resetAt', {
                      time: new Date(classification.resetAt).toLocaleString(),
                    })}
              </Typography.Text>
              {/* §17.3: rendered as plain text — control characters are never interpreted. */}
              {classification.evidence !== undefined && (
                <Typography.Paragraph className="rate-limit-evidence" type="secondary">
                  {classification.evidence}
                </Typography.Paragraph>
              )}
            </Space>
          }
          action={
            <Space direction="vertical">
              <Button size="small" type="primary" onClick={() => openContinuation(run)}>
                {t('rateLimit.continue')}
              </Button>
              <Button size="small" loading={retrying} onClick={() => void retry()}>
                {t('rateLimit.retry')}
              </Button>
              <Button size="small" type="text" onClick={() => setDismissedFor(run.id)}>
                {t('rateLimit.wait')}
              </Button>
            </Space>
          }
        />
        <ContinueWithAccountModal onContinued={onOpenRun} />
      </>
    )
  }

  if (
    classification.kind === 'authentication-required' ||
    classification.kind === 'authentication-expired'
  ) {
    const expired = classification.kind === 'authentication-expired'
    const profileId = run.accountProfileId
    return (
      <>
        <Alert
          type="warning"
          showIcon
          message={t(expired ? 'rateLimit.authExpired.title' : 'rateLimit.authRequired.title')}
          description={t(
            expired ? 'rateLimit.authExpired.description' : 'rateLimit.authRequired.description',
          )}
          {...(profileId === undefined
            ? {}
            : {
                action: (
                  <Button size="small" type="primary" onClick={() => setRelogin(true)}>
                    {t('rateLimit.relogin')}
                  </Button>
                ),
              })}
        />
        {profileId !== undefined && (
          <Drawer
            title={t('accounts.login.title', {
              name: accountName ?? run.profileSnapshot?.accountProfileName ?? profileId,
            })}
            width={720}
            open={relogin}
            onClose={() => setRelogin(false)}
            destroyOnHidden
          >
            {relogin && (
              <LoginTerminalView
                profileId={profileId}
                title={accountName ?? profileId}
                className="account-login-terminal"
                onExited={() => setRelogin(false)}
              />
            )}
          </Drawer>
        )}
      </>
    )
  }

  return null
}
