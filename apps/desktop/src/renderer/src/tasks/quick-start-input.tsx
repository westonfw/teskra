import { DownOutlined, UpOutlined } from '@ant-design/icons'
import { Alert, Button, Input, Tooltip, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'

import type { PublicAppError, ResolvedRunDefaults, SendTaskMessageResult } from '@teskra/contracts'

import { AccountSelect } from '../accounts/account-select'
import { useAccountProfileStore } from '../accounts/account-profile-store'
import { AgentPicker } from '../agents/agent-picker'
import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
import { agentRuntimeKey, useAgentStore } from '../stores/agent-store'
import { useNavigationStore } from '../stores/navigation-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import {
  buildSendMessageRequest,
  formatRunDefaultsSummary,
  isNoAgentAvailable,
  runDefaultsReasonLines,
  type QuickStartEdits,
} from './quick-start-model'

interface QuickStartInputProps {
  readonly workspaceId: string
  /** Present on the Task page: the Run binds to this Task; absent = create from first line. */
  readonly taskId?: string | undefined
  /** Called after Main accepted the message (e.g. select the newly created Task). */
  readonly onAccepted?: ((result: SendTaskMessageResult) => void) | undefined
}

/**
 * TASK-135 (Milestone 26 §12) — the thread-first quick-start input. One text
 * box + send; the gray line above it shows the resolved run defaults
 * (「agent · 账号 · 模式 · 审批」, reasons in the tooltip) and expands into a
 * per-send editor (Agent / account only — the fixed thread-mode values are a
 * note, never a choice, so attended + manual cannot be picked here).
 *
 * With no available Agent (resolve-defaults VALIDATION_FAILED) the input is
 * replaced by a disabled notice linking to Settings → Agents.
 */
export function QuickStartInput({ workspaceId, taskId, onAccepted }: QuickStartInputProps) {
  const { t } = useTranslation()
  const workspace = useWorkspaceStore((state) => state.current)
  const navigate = useNavigationStore((state) => state.navigate)
  const definitions = useAgentStore((state) => state.definitions)
  const health = useAgentStore((state) => state.health)
  const profiles = useAccountProfileStore((state) => state.profiles)

  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [defaults, setDefaults] = useState<ResolvedRunDefaults>()
  const [unavailable, setUnavailable] = useState(false)
  const [sendError, setSendError] = useState<PublicAppError>()
  const [expanded, setExpanded] = useState(false)
  const [edits, setEdits] = useState<QuickStartEdits>({})

  useEffect(() => {
    let active = true
    setDefaults(undefined)
    setUnavailable(false)
    void window.teskra.agent.resolveDefaults({ workspaceId }).then((result) => {
      if (!active) return
      if (result.ok) {
        setDefaults(result.data)
      } else {
        setUnavailable(isNoAgentAvailable(result.error))
        if (!isNoAgentAvailable(result.error)) setSendError(result.error)
      }
    })
    return () => {
      active = false
    }
  }, [workspaceId])

  // Changing the Agent resets the per-send account choice to "auto".
  useEffect(() => {
    setEdits((current) => ({ agentType: current.agentType }))
  }, [edits.agentType])

  const runtimeHealth = useMemo(
    () =>
      workspace === undefined
        ? []
        : definitions.flatMap((definition) => {
            const status = health[agentRuntimeKey(definition.id, workspace.runtime)]
            return status === undefined ? [] : [status]
          }),
    [definitions, health, workspace],
  )

  if (unavailable) {
    return (
      <Alert
        className="quick-start-unavailable"
        type="warning"
        showIcon
        message={t('quickStart.unavailable')}
        action={
          <Button type="link" onClick={() => navigate('settings')}>
            {t('quickStart.openAgentsSettings')}
          </Button>
        }
      />
    )
  }
  if (defaults === undefined) return null

  const effectiveAgentType = edits.agentType ?? defaults.agentType
  const accountName =
    defaults.accountProfileId === undefined
      ? undefined
      : profiles.find((profile) => profile.id === defaults.accountProfileId)?.name
  const summary = formatRunDefaultsSummary(defaults, accountName, t)
  const reasonLines = runDefaultsReasonLines(defaults.reasons, t)

  const handleSend = async (): Promise<void> => {
    if (sending || text.trim() === '') return
    setSending(true)
    setSendError(undefined)
    try {
      const result = await window.teskra.task.sendMessage(
        buildSendMessageRequest({ workspaceId, taskId, text, edits }),
      )
      if (!result.ok) {
        setSendError(result.error)
        return
      }
      setText('')
      onAccepted?.(result.data)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="quick-start-input">
      <div className="quick-start-defaults-row">
        <Tooltip title={reasonLines.join('\n')}>
          <Typography.Text
            type="secondary"
            className="quick-start-defaults-summary"
            onClick={() => setExpanded((current) => !current)}
          >
            {summary} {expanded ? <UpOutlined /> : <DownOutlined />}
          </Typography.Text>
        </Tooltip>
      </div>
      {expanded && (
        <div className="quick-start-defaults-editor">
          <AgentPicker
            definitions={definitions}
            health={runtimeHealth}
            role="implementer"
            value={effectiveAgentType}
            onChange={(agentType) => setEdits({ agentType })}
          />
          <AccountSelect
            agentId={effectiveAgentType}
            value={edits.accountProfileId}
            onChange={(accountProfileId) =>
              setEdits((current) => ({ ...current, accountProfileId }))
            }
          />
          <Typography.Text type="secondary">{t('quickStart.fixedNote')}</Typography.Text>
        </div>
      )}
      <div className="quick-start-composer">
        <Input.TextArea
          value={text}
          autoSize={{ minRows: 2, maxRows: 6 }}
          placeholder={t('quickStart.placeholder')}
          disabled={sending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter inserts a newline.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void handleSend()
            }
          }}
        />
        <Button
          type="primary"
          loading={sending}
          disabled={text.trim() === ''}
          onClick={() => void handleSend()}
        >
          {t('quickStart.send')}
        </Button>
      </div>
      {sendError !== undefined && (
        <AppErrorAlert
          className="page-alert"
          error={sendError}
          onClose={() => setSendError(undefined)}
        />
      )}
    </div>
  )
}
