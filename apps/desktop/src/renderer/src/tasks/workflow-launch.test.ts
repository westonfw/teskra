import { describe, expect, it } from 'vitest'

import {
  buildFullWorkflowStartRequest,
  launchSummaryModel,
  openWorkflowLaunchDialog,
  showLaunchEditor,
  showLaunchSummary,
} from './workflow-launch'

describe('workflow launch dialog state (TASK-137)', () => {
  it('opens in the summary state with no overrides', () => {
    expect(openWorkflowLaunchDialog()).toEqual({
      mode: 'summary',
      implementer: undefined,
      reviewers: [],
      testCommand: '',
    })
  })

  it('toggles between the summary and the edit state, keeping the overrides', () => {
    const opened = openWorkflowLaunchDialog()
    const editing = showLaunchEditor({ ...opened, testCommand: 'make test' })
    expect(editing.mode).toBe('edit')
    expect(editing.testCommand).toBe('make test')
    const back = showLaunchSummary(editing)
    expect(back.mode).toBe('summary')
    expect(back.testCommand).toBe('make test')
  })
})

describe('launchSummaryModel (TASK-137)', () => {
  it('joins the resolved reviewers and passes the repo flag through', () => {
    expect(
      launchSummaryModel({
        implementer: 'codex',
        reviewers: ['claude-code', 'kimi'],
        testCommand: 'make test',
        testCommandFromRepo: true,
      }),
    ).toEqual({
      implementer: 'codex',
      reviewersText: 'claude-code, kimi',
      testCommand: 'make test',
      testCommandFromRepo: true,
    })
  })

  it('reports no reviewers text when the resolution found none', () => {
    const model = launchSummaryModel({
      implementer: 'codex',
      reviewers: [],
      testCommand: 'npm test',
      testCommandFromRepo: false,
    })
    expect(model.reviewersText).toBeUndefined()
    expect(model.testCommandFromRepo).toBe(false)
  })
})

describe('buildFullWorkflowStartRequest (TASK-137)', () => {
  const base = { workspaceId: 'ws-1', taskId: 'task-1' }

  it('sends no override fields when every input is empty (default launch)', () => {
    expect(
      buildFullWorkflowStartRequest({
        ...base,
        implementer: undefined,
        reviewers: [],
        testCommand: '   ',
      }),
    ).toEqual({ workspaceId: 'ws-1', taskId: 'task-1' })
  })

  it('includes only the overrides the user actually set, trimmed', () => {
    expect(
      buildFullWorkflowStartRequest({
        ...base,
        implementer: 'codex',
        reviewers: ['claude-code'],
        testCommand: '  make test  ',
      }),
    ).toEqual({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      implementer: 'codex',
      reviewers: ['claude-code'],
      testCommand: 'make test',
    })
  })
})
