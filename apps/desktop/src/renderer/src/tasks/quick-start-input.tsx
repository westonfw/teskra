import { DownOutlined, UpOutlined } from '@ant-design/icons'
import { Alert, AutoComplete, Button, Input, Tooltip, Typography } from 'antd'
import type { TextAreaRef } from 'antd/es/input/TextArea'
import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  ProfileAlias,
  PublicAppError,
  ResolvedRunDefaults,
  SendTaskMessageResult,
} from '@teskra/contracts'

import { AccountSelect } from '../accounts/account-select'
import { useAccountProfileStore } from '../accounts/account-profile-store'
import { AgentPicker } from '../agents/agent-picker'
import { AppErrorAlert } from '../components/app-error-alert'
import { useTranslation } from '../i18n'
import { agentRuntimeKey, useAgentStore } from '../stores/agent-store'
import { useNavigationStore } from '../stores/navigation-store'
import { useWorkspaceStore } from '../stores/workspace-store'
import {
  applyDirectiveCompletion,
  buildDirectiveCompletionOptions,
  buildSendMessageRequest,
  formatRunDefaultsSummary,
  getDirectiveCompletion,
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
 * TASK-136: the composer completes `/` directives and `@` mentions from the
 * known candidate sets (directive table, AgentRegistry ids, account
 * aliases/profile ids) — never from free text; Enter picks the highlighted
 * completion while the dropdown is open and sends otherwise.
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
  // TASK-136: `/` and `@` directive completion state. The caret lives in
  // state because the option list depends on it; the pending-select ref
  // tells AutoComplete's onChange apart from a real text edit.
  const [caret, setCaret] = useState(0)
  const [accountAliases, setAccountAliases] = useState<readonly string[]>([])
  const [completionOpen, setCompletionOpen] = useState(false)
  const textAreaRef = useRef<TextAreaRef | null>(null)
  const pendingSelectRef = useRef<string | undefined>(undefined)

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

  // Account alias candidates for /account completion (TASK-111 bindings).
  useEffect(() => {
    let active = true
    void window.teskra.account.listAliases({ kind: 'account' }).then((result) => {
      if (!active) return
      if (result.ok) {
        setAccountAliases(result.data.map((alias: ProfileAlias) => alias.alias))
      }
    })
    return () => {
      active = false
    }
  }, [workspaceId])

  const completion = useMemo(() => getDirectiveCompletion(text, caret), [text, caret])
  const completionOptions = useMemo(() => {
    if (completion === undefined) return []
    return buildDirectiveCompletionOptions(
      completion,
      {
        agentIds: definitions.map((definition) => definition.id),
        accounts: [...accountAliases, ...profiles.map((profile) => profile.id)],
      },
      t,
    )
  }, [completion, definitions, accountAliases, profiles, t])

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
      setCaret(0)
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
        <AutoComplete
          value={text}
          options={completionOptions}
          open={completionOpen && completionOptions.length > 0}
          onOpenChange={setCompletionOpen}
          filterOption={false}
          disabled={sending}
          style={{ flex: 1 }}
          onSelect={(value: string) => {
            pendingSelectRef.current = value
          }}
          onChange={(value: string) => {
            const pending = pendingSelectRef.current
            if (pending !== undefined) {
              // A completion was picked: splice it into the token under the
              // caret instead of letting AutoComplete replace the whole text.
              pendingSelectRef.current = undefined
              if (completion !== undefined) {
                const applied = applyDirectiveCompletion(text, completion, pending)
                setText(applied.text)
                setCaret(applied.caret)
                requestAnimationFrame(() => {
                  const element = textAreaRef.current?.resizableTextArea?.textArea
                  element?.focus()
                  element?.setSelectionRange(applied.caret, applied.caret)
                })
              }
              return
            }
            setText(value)
            setCaret(
              textAreaRef.current?.resizableTextArea?.textArea.selectionStart ?? value.length,
            )
          }}
        >
          <Input.TextArea
            ref={textAreaRef}
            autoSize={{ minRows: 2, maxRows: 6 }}
            placeholder={t('quickStart.placeholder')}
            disabled={sending}
            onClick={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
            onKeyDown={(event) => {
              // While the completion dropdown is open, Enter picks the active
              // option (AutoComplete handles the key) instead of sending.
              if (completionOpen && completionOptions.length > 0) return
              // Enter sends; Shift+Enter inserts a newline.
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void handleSend()
              }
            }}
          />
        </AutoComplete>
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
