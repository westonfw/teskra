import { describe, expect, it } from 'vitest'

import { doctorReportSchema, doctorRunChannel } from './index'

describe('Doctor contracts (TASK-041)', () => {
  const firstCheck = {
    id: 'git',
    label: 'Git',
    outcome: 'issue',
    severity: 'warning',
    summary: 'Git needs attention.',
  }
  const report = {
    generatedAt: '2026-09-10T00:00:00.000Z',
    workspaceId: 'workspace-1',
    severity: 'warning',
    issueCount: 1,
    checks: [firstCheck],
  }

  it('validates a severity-bearing health report', () => {
    expect(doctorReportSchema.safeParse(report).success).toBe(true)
    expect(doctorRunChannel.response.safeParse({ ok: true, data: report }).success).toBe(true)
  })

  it('rejects issues without severity and unknown request fields', () => {
    const withoutSeverity = {
      id: firstCheck.id,
      label: firstCheck.label,
      outcome: firstCheck.outcome,
      summary: firstCheck.summary,
    }
    expect(doctorReportSchema.safeParse({ ...report, checks: [withoutSeverity] }).success).toBe(
      false,
    )
    expect(
      doctorRunChannel.request.safeParse({ workspaceId: 'workspace-1', repair: true }).success,
    ).toBe(false)
  })
})
