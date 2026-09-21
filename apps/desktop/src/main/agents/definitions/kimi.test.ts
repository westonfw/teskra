import { agentDefinitionSchema } from '@teskra/contracts'
import { describe, expect, it } from 'vitest'

import { KIMI_AGENT } from './kimi'

describe('KIMI_AGENT', () => {
  it('is a valid Agent definition', () => {
    expect(agentDefinitionSchema.safeParse(KIMI_AGENT).success).toBe(true)
  })

  it('declares the kimi executable, headless prompt mode and implementer defaults', () => {
    expect(KIMI_AGENT.id).toBe('kimi')
    expect(KIMI_AGENT.executable.command).toBe('kimi')
    expect(KIMI_AGENT.prompt.headlessArgs).toEqual(['--prompt'])
    expect(KIMI_AGENT.capabilities).toMatchObject({
      interactive: true,
      headless: true,
      resume: true,
      readOnlyMode: true,
      modelSelection: true,
    })
    expect(KIMI_AGENT.defaults).toEqual({ role: 'implementer', permissionProfile: 'safe-auto' })
    // TASK-122: Kimi declares no structured-output protocol family yet.
    expect(KIMI_AGENT.output).toEqual({ structured: 'none' })
  })
})
