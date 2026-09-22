import { describe, expect, it } from 'vitest'

import type { ResolvedRunDefaults } from '@teskra/contracts'

import { translate } from '../i18n'
import {
  buildSendMessageRequest,
  formatRunDefaultsSummary,
  isNoAgentAvailable,
  runDefaultsReasonLines,
} from './quick-start-model'

const DEFAULTS: ResolvedRunDefaults = {
  agentType: 'codex',
  accountProfileId: 'acct-1',
  mode: 'exec',
  executionMode: 'orchestrated',
  approvalMode: 'safe-auto',
  isolation: 'worktree',
  reasons: [
    { key: 'runDefaults.reason.agent.configured', params: { agent: 'codex' } },
    {
      key: 'runDefaults.reason.accountProfile.default',
      params: { agent: 'codex', profileId: 'a' },
    },
    { key: 'runDefaults.reason.mode.fixed' },
  ],
}

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate('en-US', key, params)

describe('buildSendMessageRequest (TASK-135)', () => {
  it('omits taskId and overrides when absent', () => {
    expect(buildSendMessageRequest({ workspaceId: 'ws-1', text: 'hello' })).toEqual({
      workspaceId: 'ws-1',
      text: 'hello',
    })
  })

  it('binds the taskId and carries only the per-send edits as overrides', () => {
    expect(
      buildSendMessageRequest({
        workspaceId: 'ws-1',
        taskId: 'task-1',
        text: 'hello',
        edits: { agentType: 'claude', accountProfileId: 'acct-9' },
      }),
    ).toEqual({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      text: 'hello',
      overrides: { agentType: 'claude', accountProfileId: 'acct-9' },
    })
  })

  it('cannot assemble attended + manual: the request has no mode/approval fields', () => {
    const request = buildSendMessageRequest({
      workspaceId: 'ws-1',
      text: 'hello',
      edits: { agentType: 'claude' },
    })
    expect(request).not.toHaveProperty('mode')
    expect(request).not.toHaveProperty('executionMode')
    expect(request).not.toHaveProperty('approvalMode')
    expect(request.overrides).not.toHaveProperty('executionMode')
    expect(request.overrides).not.toHaveProperty('approvalMode')
  })
})

describe('formatRunDefaultsSummary', () => {
  it('renders agent · account · mode · approval with the account display name', () => {
    expect(formatRunDefaultsSummary(DEFAULTS, 'Work account', t)).toBe(
      'codex · Work account · isolated · safe-auto',
    )
  })

  it('falls back to the profile id and to the auto-account label', () => {
    expect(formatRunDefaultsSummary(DEFAULTS, undefined, t)).toBe(
      'codex · acct-1 · isolated · safe-auto',
    )
    const noAccount: ResolvedRunDefaults = { ...DEFAULTS }
    delete (noAccount as { accountProfileId?: string }).accountProfileId
    expect(formatRunDefaultsSummary(noAccount, undefined, t)).toBe(
      'codex · auto account · isolated · safe-auto',
    )
  })
})

describe('isNoAgentAvailable', () => {
  it('disables the input only for the no-Agent VALIDATION_FAILED', () => {
    expect(
      isNoAgentAvailable({ code: 'VALIDATION_FAILED', message: 'No Agent', retryable: false }),
    ).toBe(true)
    expect(isNoAgentAvailable({ code: 'UNKNOWN', message: 'boom', retryable: true })).toBe(false)
    expect(
      isNoAgentAvailable({ code: 'WORKSPACE_NOT_FOUND', message: 'gone', retryable: false }),
    ).toBe(false)
  })
})

describe('runDefaultsReasonLines', () => {
  it('localizes every reason through the dictionary', () => {
    expect(runDefaultsReasonLines(DEFAULTS.reasons, t)).toEqual([
      'Default Agent from configuration: codex',
      'Default account for codex: a',
      'Thread runs always launch in exec mode',
    ])
  })

  it('passes unknown keys through verbatim', () => {
    expect(runDefaultsReasonLines([{ key: 'runDefaults.reason.unknown' }], t)).toEqual([
      'runDefaults.reason.unknown',
    ])
  })
})
