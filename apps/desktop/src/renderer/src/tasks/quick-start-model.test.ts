import { describe, expect, it } from 'vitest'

import type { ResolvedRunDefaults } from '@teskra/contracts'

import { translate } from '../i18n'
import {
  applyDirectiveCompletion,
  buildDirectiveCompletionOptions,
  buildSendMessageRequest,
  formatRunDefaultsSummary,
  getDirectiveCompletion,
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

describe('getDirectiveCompletion (TASK-136)', () => {
  it('completes a directive name on a leading slash token', () => {
    expect(getDirectiveCompletion('/ac', 3)).toEqual({
      kind: 'directive',
      start: 0,
      end: 3,
      query: '/ac',
    })
  })

  it('completes directive arguments only for the known directives', () => {
    expect(getDirectiveCompletion('/agent co', 9)).toEqual({
      kind: 'agent',
      start: 7,
      end: 9,
      query: 'co',
    })
    expect(getDirectiveCompletion('/account ', 9)).toEqual({
      kind: 'account',
      start: 9,
      end: 9,
      query: '',
    })
    expect(getDirectiveCompletion('/mode a', 7)).toMatchObject({ kind: 'mode', query: 'a' })
    expect(getDirectiveCompletion('/approval sa', 12)).toMatchObject({
      kind: 'approval',
      query: 'sa',
    })
    expect(getDirectiveCompletion('/workflow f', 11)).toMatchObject({
      kind: 'workflow',
      query: 'f',
    })
  })

  it('does not complete a /model argument or a second argument', () => {
    expect(getDirectiveCompletion('/model gp', 9)).toBeUndefined()
    expect(getDirectiveCompletion('/agent codex cla', 16)).toBeUndefined()
    expect(getDirectiveCompletion('/workflow full --te', 19)).toBeUndefined()
  })

  it('completes an @mention on the first line only', () => {
    expect(getDirectiveCompletion('@cla', 4)).toEqual({
      kind: 'mention',
      start: 0,
      end: 4,
      query: '@cla',
    })
    expect(getDirectiveCompletion('@claude review', 14)).toBeUndefined()
    expect(getDirectiveCompletion('/mode attended\n@cla', 19)).toBeUndefined()
  })

  it('completes on later leading directive lines but never in the body', () => {
    const text = '/agent codex\n/mo'
    expect(getDirectiveCompletion(text, text.length)).toEqual({
      kind: 'directive',
      start: 13,
      end: 16,
      query: '/mo',
    })
    // A `/` line after body text is prose, not a directive.
    const body = 'fix the bug\n/ag'
    expect(getDirectiveCompletion(body, body.length)).toBeUndefined()
  })
})

describe('buildDirectiveCompletionOptions (TASK-136)', () => {
  const candidates = { agentIds: ['codex', 'claude'], accounts: ['work', 'acct-1'] }

  it('prefix-filters directive names with localized labels', () => {
    const options = buildDirectiveCompletionOptions(
      { kind: 'directive', start: 0, end: 2, query: '/a' },
      candidates,
      t,
    )
    expect(options.map((option) => option.value)).toEqual(['/agent ', '/account ', '/approval '])
    expect(options[0]?.label).toContain('Agent for this send')
  })

  it('suggests agent ids for /agent and @mention from the registry list only', () => {
    expect(
      buildDirectiveCompletionOptions(
        { kind: 'agent', start: 7, end: 8, query: 'c' },
        candidates,
        t,
      ).map((option) => option.value),
    ).toEqual(['codex ', 'claude '])
    expect(
      buildDirectiveCompletionOptions(
        { kind: 'mention', start: 0, end: 2, query: '@c' },
        candidates,
        t,
      ).map((option) => option.value),
    ).toEqual(['@codex ', '@claude '])
  })

  it('suggests account aliases and profile ids for /account', () => {
    expect(
      buildDirectiveCompletionOptions(
        { kind: 'account', start: 9, end: 10, query: 'w' },
        candidates,
        t,
      ).map((option) => option.value),
    ).toEqual(['work '])
  })

  it('suggests the mode / approval / workflow enums', () => {
    expect(
      buildDirectiveCompletionOptions(
        { kind: 'mode', start: 6, end: 6, query: '' },
        candidates,
        t,
      ).map((option) => option.value),
    ).toEqual(['attended ', 'isolated '])
    expect(
      buildDirectiveCompletionOptions(
        { kind: 'approval', start: 10, end: 12, query: 'sa' },
        candidates,
        t,
      ).map((option) => option.value),
    ).toEqual(['safe-auto '])
    expect(
      buildDirectiveCompletionOptions(
        { kind: 'workflow', start: 10, end: 10, query: '' },
        candidates,
        t,
      ).map((option) => option.value),
    ).toEqual(['full '])
  })
})

describe('applyDirectiveCompletion (TASK-136)', () => {
  it('splices the selected value into the token and reports the caret', () => {
    const text = '/agent co\ndo the thing'
    const completion = getDirectiveCompletion(text, 9)
    expect(completion).toBeDefined()
    const applied = applyDirectiveCompletion(text, completion!, 'codex ')
    expect(applied).toEqual({ text: '/agent codex \ndo the thing', caret: 13 })
  })

  it('replaces the mention token on the first line', () => {
    const applied = applyDirectiveCompletion(
      '@cla',
      { kind: 'mention', start: 0, end: 4, query: '@cla' },
      '@claude ',
    )
    expect(applied).toEqual({ text: '@claude ', caret: 8 })
  })
})
