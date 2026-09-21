import type { DecisionOption, PendingDecision } from '@teskra/contracts'
import { describe, expect, it } from 'vitest'

import { translate, type TranslationKey } from '../i18n'
import {
  countOpenDecisions,
  decisionContextLinks,
  decisionDetailLines,
  decisionOptionLabel,
  decisionOptionNeedsConfirm,
  groupDecisionsBySeverity,
  isContinueWithAccountOption,
} from './decision-view-model'

const t = (key: TranslationKey, params?: Record<string, string | number>): string =>
  translate('en-US', key, params)

function decision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: 'decision-1',
    workspaceId: 'workspace-1',
    kind: 'agent_blocker',
    status: 'open',
    severity: 'warning',
    dedupeKey: 'agent_blocker:run-1',
    title: 'The Agent reported a blocker',
    detail: { kind: 'agent_blocker', text: 'need help' },
    options: [
      { id: 'acknowledge', label: 'Acknowledge' },
      { id: 'stop', label: 'Stop the run' },
    ],
    createdAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

describe('decision view model (TASK-131)', () => {
  it('groups by severity in blocking → warning → info order, newest first inside a group', () => {
    const groups = groupDecisionsBySeverity([
      decision({ id: 'info-1', severity: 'info' }),
      decision({ id: 'blocking-1', severity: 'blocking', createdAt: '2026-09-10T01:00:00.000Z' }),
      decision({ id: 'warning-1', severity: 'warning', createdAt: '2026-09-10T02:00:00.000Z' }),
      decision({ id: 'warning-2', severity: 'warning', createdAt: '2026-09-10T03:00:00.000Z' }),
    ])

    expect(groups.map((group) => group.severity)).toEqual(['blocking', 'warning', 'info'])
    expect(groups[1]?.decisions.map((entry) => entry.id)).toEqual(['warning-2', 'warning-1'])
  })

  it('drops empty severity groups', () => {
    const groups = groupDecisionsBySeverity([decision({ severity: 'info' })])
    expect(groups.map((group) => group.severity)).toEqual(['info'])
    expect(groupDecisionsBySeverity([])).toEqual([])
  })

  it('counts only open decisions for the badge', () => {
    expect(
      countOpenDecisions([
        decision({ id: 'open-1', status: 'open' }),
        decision({ id: 'resolved-1', status: 'resolved' }),
        decision({ id: 'open-2', status: 'open' }),
      ]),
    ).toBe(2)
  })

  it('builds source-context links for run / workflow / worktree references', () => {
    const bare = decision()
    expect(decisionContextLinks(bare)).toEqual([])

    const linked = decision({ runId: 'run-1', workflowRunId: 'wfr-1', worktreeId: 'wt-1' })
    expect(decisionContextLinks(linked)).toEqual([
      { page: 'runs', openRunId: 'run-1', labelKey: 'inbox.context.run' },
      { page: 'tasks', openRunId: undefined, labelKey: 'inbox.context.workflow' },
      { page: 'git', openRunId: undefined, labelKey: 'inbox.context.worktree' },
    ])
  })

  it('renders detail lines per kind', () => {
    expect(
      decisionDetailLines(
        decision({
          kind: 'shell_confirmation',
          detail: { kind: 'shell_confirmation', command: 'rm -rf build', cwd: '/repo' },
        }),
        t,
      ),
    ).toEqual([{ text: 'rm -rf build', code: true }, { text: 'Working directory: /repo' }])

    expect(
      decisionDetailLines(
        decision({ kind: 'agent_blocker', detail: { kind: 'agent_blocker', text: 'stuck' } }),
        t,
      ),
    ).toEqual([{ text: 'stuck' }])

    expect(
      decisionDetailLines(
        decision({ kind: 'stalled_run', detail: { kind: 'stalled_run', silentForMs: 3_660_000 } }),
        t,
      ),
    ).toEqual([{ text: 'Silent for 1h 1m' }])

    expect(
      decisionDetailLines(
        decision({
          kind: 'merge_blocked',
          detail: {
            kind: 'merge_blocked',
            blockers: [
              { code: 'dirty', message: 'uncommitted changes', overridable: true },
              { code: 'criteria', message: 'no criteria result', overridable: true },
            ],
          },
        }),
        t,
      ).map((line) => line.text),
    ).toEqual(['dirty: uncommitted changes', 'criteria: no criteria result'])

    expect(
      decisionDetailLines(
        decision({
          kind: 'rate_limit',
          detail: { kind: 'rate_limit', message: 'quota exhausted' },
        }),
        t,
      ),
    ).toEqual([{ text: 'quota exhausted' }, { text: 'The provider did not report a reset time.' }])

    expect(
      decisionDetailLines(
        decision({
          kind: 'handoff_degraded',
          detail: {
            kind: 'handoff_degraded',
            rawPath: '/data/runs/r/handoff.txt',
            issues: ['bad'],
          },
        }),
        t,
      ),
    ).toEqual([{ text: '/data/runs/r/handoff.txt', code: true }, { text: 'bad' }])
  })

  it('localizes known option ids and falls back to the persisted label otherwise', () => {
    const zh = (key: TranslationKey, params?: Record<string, string | number>): string =>
      translate('zh-CN', key, params)
    // A known id renders the dictionary entry, not the persisted English label.
    expect(decisionOptionLabel({ id: 'force_merge', label: 'Force merge' }, zh)).toBe('强制合并')
    const unknown: DecisionOption = { id: 'brand_new_option', label: 'Persisted label' }
    expect(decisionOptionLabel(unknown, zh)).toBe('Persisted label')
    expect(decisionOptionLabel(unknown, t)).toBe('Persisted label')
  })

  it('flags danger options for the second confirmation', () => {
    expect(
      decisionOptionNeedsConfirm({ id: 'force_merge', label: 'Force merge', danger: true }),
    ).toBe(true)
    expect(decisionOptionNeedsConfirm({ id: 'retry', label: 'Retry' })).toBe(false)
  })

  it('detects the rate_limit continue_with_account renderer-flow option', () => {
    const rateLimit = decision({
      kind: 'rate_limit',
      detail: { kind: 'rate_limit', message: 'quota' },
    })
    const option: DecisionOption = { id: 'continue_with_account', label: 'Continue' }
    expect(isContinueWithAccountOption(rateLimit, option)).toBe(true)
    expect(isContinueWithAccountOption(decision(), option)).toBe(false)
    expect(isContinueWithAccountOption(rateLimit, { id: 'retry', label: 'Retry' })).toBe(false)
  })
})
