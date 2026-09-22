import { describe, expect, it } from 'vitest'

import { IPC_NAME_MAX, type MessageDirectiveError } from '@teskra/contracts'

import { parseMessageDirectives } from './message-directives'

function expectError(text: string): MessageDirectiveError {
  const result = parseMessageDirectives(text)
  if (result.ok) throw new Error(`expected a parse error for ${JSON.stringify(text)}`)
  return result.error
}

describe('parseMessageDirectives', () => {
  describe('no directives → run branch', () => {
    it('treats plain text as the prompt', () => {
      const result = parseMessageDirectives('Fix the login page\nUse OAuth')
      expect(result).toEqual({
        ok: true,
        directives: { branch: 'run', prompt: 'Fix the login page\nUse OAuth' },
      })
    })

    it('trims the prompt', () => {
      const result = parseMessageDirectives('  hello world  \n\n')
      expect(result).toEqual({ ok: true, directives: { branch: 'run', prompt: 'hello world' } })
    })
  })

  describe('every slash directive', () => {
    it('/agent sets agentType', () => {
      const result = parseMessageDirectives('/agent codex\ndo the thing')
      expect(result).toEqual({
        ok: true,
        directives: { branch: 'run', agentType: 'codex', prompt: 'do the thing' },
      })
    })

    it('/account keeps the raw alias-or-id value for Main to resolve', () => {
      const result = parseMessageDirectives('/account work\ndo the thing')
      expect(result).toEqual({
        ok: true,
        directives: { branch: 'run', account: 'work', prompt: 'do the thing' },
      })
    })

    it('/mode attended → executionMode attended', () => {
      const result = parseMessageDirectives('/mode attended\ndo the thing')
      expect(result).toEqual({
        ok: true,
        directives: { branch: 'run', executionMode: 'attended', prompt: 'do the thing' },
      })
    })

    it('/mode isolated → executionMode orchestrated', () => {
      const result = parseMessageDirectives('/mode isolated\ndo the thing')
      expect(result).toEqual({
        ok: true,
        directives: { branch: 'run', executionMode: 'orchestrated', prompt: 'do the thing' },
      })
    })

    it.each(['read-only', 'manual', 'safe-auto', 'full-auto'] as const)(
      '/approval %s maps to approvalMode',
      (mode) => {
        const result = parseMessageDirectives(`/approval ${mode}\ndo the thing`)
        expect(result).toEqual({
          ok: true,
          directives: { branch: 'run', approvalMode: mode, prompt: 'do the thing' },
        })
      },
    )

    it('/model sets model', () => {
      const result = parseMessageDirectives('/model gpt-5-codex\ndo the thing')
      expect(result).toEqual({
        ok: true,
        directives: { branch: 'run', model: 'gpt-5-codex', prompt: 'do the thing' },
      })
    })

    it('combines several directives across consecutive leading lines', () => {
      const result = parseMessageDirectives(
        '/agent codex\n/account work\n/mode isolated\n/approval safe-auto\n/model gpt-5\ndo the thing',
      )
      expect(result).toEqual({
        ok: true,
        directives: {
          branch: 'run',
          agentType: 'codex',
          account: 'work',
          executionMode: 'orchestrated',
          approvalMode: 'safe-auto',
          model: 'gpt-5',
          prompt: 'do the thing',
        },
      })
    })
  })

  describe('/workflow full', () => {
    it('maps to the workflow branch with an empty body allowed', () => {
      const result = parseMessageDirectives('/workflow full')
      expect(result).toEqual({ ok: true, directives: { branch: 'workflow', prompt: '' } })
    })

    it('--test overrides the test command', () => {
      const result = parseMessageDirectives('/workflow full --test "npm run test:unit"')
      expect(result).toEqual({
        ok: true,
        directives: { branch: 'workflow', testCommand: 'npm run test:unit', prompt: '' },
      })
    })

    it('keeps the body as prompt when present', () => {
      const result = parseMessageDirectives('/workflow full\nImplement the login page')
      expect(result).toEqual({
        ok: true,
        directives: { branch: 'workflow', prompt: 'Implement the login page' },
      })
    })

    it('/agent and /model combine with /workflow full', () => {
      const result = parseMessageDirectives('/agent codex\n/model gpt-5\n/workflow full')
      expect(result).toEqual({
        ok: true,
        directives: { branch: 'workflow', agentType: 'codex', model: 'gpt-5', prompt: '' },
      })
    })

    it('rejects an unknown workflow name', () => {
      const error = expectError('/workflow half\ntext')
      expect(error).toMatchObject({
        line: 1,
        reason: 'invalid-value',
        directive: 'workflow',
        value: 'half',
      })
    })

    it('rejects unknown flags', () => {
      const error = expectError('/workflow full --fast\ntext')
      expect(error).toMatchObject({
        line: 1,
        reason: 'invalid-value',
        directive: 'workflow',
        value: '--fast',
      })
    })

    it('rejects --test without a value', () => {
      const error = expectError('/workflow full --test\ntext')
      expect(error).toMatchObject({
        line: 1,
        reason: 'invalid-value',
        directive: 'workflow',
        value: '--test',
      })
    })

    it('rejects an empty --test value', () => {
      const error = expectError('/workflow full --test ""\ntext')
      expect(error).toMatchObject({ line: 1, reason: 'invalid-value', directive: 'workflow' })
    })

    it.each(['mode', 'approval', 'account'])('rejects /%s combined with /workflow full', (name) => {
      const value = name === 'mode' ? 'attended' : name === 'approval' ? 'manual' : 'work'
      const error = expectError(`/workflow full\n/${name} ${value}\ntext`)
      expect(error).toMatchObject({ line: 2, reason: 'incompatible-directive', directive: name })
    })
  })

  describe('@mention', () => {
    it('maps to the review branch with the mention agent and the text as prompt', () => {
      const result = parseMessageDirectives('@claude review the last run')
      expect(result).toEqual({
        ok: true,
        directives: { branch: 'review', reviewerAgentId: 'claude', prompt: 'review the last run' },
      })
    })

    it('keeps multi-line review text', () => {
      const result = parseMessageDirectives('@codex check this\nFocus on the diff')
      expect(result).toEqual({
        ok: true,
        directives: {
          branch: 'review',
          reviewerAgentId: 'codex',
          prompt: 'check this\nFocus on the diff',
        },
      })
    })

    it('rejects a bare @', () => {
      const error = expectError('@ review this')
      expect(error).toMatchObject({ line: 1, reason: 'invalid-value' })
    })

    it('rejects a mention without review text', () => {
      const error = expectError('@codex')
      expect(error).toMatchObject({ line: 1, reason: 'missing-body' })
    })

    it('rejects mixing an @mention with / directives', () => {
      const error = expectError('/mode attended\n@claude review this')
      expect(error).toMatchObject({ line: 2, reason: 'mixed-mention' })
    })
  })

  describe('positional rules', () => {
    it('a directive after the first body line is body text, not a directive', () => {
      const result = parseMessageDirectives('fix the bug\n/agent codex')
      expect(result).toEqual({
        ok: true,
        directives: { branch: 'run', prompt: 'fix the bug\n/agent codex' },
      })
    })

    it('a directive after a blank line ends the block and becomes body text', () => {
      const result = parseMessageDirectives('/agent codex\n\n/mode attended\nfix it')
      expect(result).toEqual({
        ok: true,
        directives: {
          branch: 'run',
          agentType: 'codex',
          prompt: '/mode attended\nfix it',
        },
      })
    })

    it('a slash line inside the review body is plain text', () => {
      const result = parseMessageDirectives('@codex review\n/mode is just text here')
      expect(result).toEqual({
        ok: true,
        directives: {
          branch: 'review',
          reviewerAgentId: 'codex',
          prompt: 'review\n/mode is just text here',
        },
      })
    })

    it('leading whitespace before a directive still counts', () => {
      const result = parseMessageDirectives('   /agent codex\ndo it')
      expect(result).toEqual({
        ok: true,
        directives: { branch: 'run', agentType: 'codex', prompt: 'do it' },
      })
    })
  })

  describe('errors carry a line number', () => {
    it('unknown directive', () => {
      const error = expectError('/agent codex\n/frobnicate x\ntext')
      expect(error).toMatchObject({ line: 2, reason: 'unknown-directive', directive: 'frobnicate' })
    })

    it('illegal enum value reports the value', () => {
      const error = expectError('/approval yolo\ntext')
      expect(error).toMatchObject({
        line: 1,
        reason: 'invalid-value',
        directive: 'approval',
        value: 'yolo',
      })
    })

    it('/mode with an unknown value', () => {
      const error = expectError('/mode hybrid\ntext')
      expect(error).toMatchObject({
        line: 1,
        reason: 'invalid-value',
        directive: 'mode',
        value: 'hybrid',
      })
    })

    it('missing directive value', () => {
      const error = expectError('/agent\ntext')
      expect(error).toMatchObject({ line: 1, reason: 'invalid-value', directive: 'agent' })
    })

    it('extra directive values', () => {
      const error = expectError('/agent codex claude\ntext')
      expect(error).toMatchObject({ line: 1, reason: 'invalid-value', directive: 'agent' })
    })

    it('duplicate directive reports the second occurrence', () => {
      const error = expectError('/agent codex\n/agent claude\ntext')
      expect(error).toMatchObject({ line: 2, reason: 'duplicate-directive', directive: 'agent' })
    })

    it('directives without a body', () => {
      const error = expectError('/agent codex\n/mode attended')
      expect(error).toMatchObject({ line: 2, reason: 'missing-body' })
    })

    it('unterminated quote', () => {
      const error = expectError('/workflow full --test "npm test\ntext')
      expect(error).toMatchObject({ line: 1, reason: 'invalid-value' })
    })

    it('directive line exceeding the IPC_NAME_MAX budget', () => {
      const error = expectError(`/${'a'.repeat(IPC_NAME_MAX)}\ntext`)
      expect(error).toMatchObject({ line: 1, reason: 'directive-line-too-long' })
    })

    it('mention agent id exceeding the IPC_NAME_MAX budget', () => {
      const error = expectError(`@${'a'.repeat(IPC_NAME_MAX + 1)} review this`)
      expect(error).toMatchObject({ line: 1, reason: 'directive-line-too-long' })
    })
  })
})
