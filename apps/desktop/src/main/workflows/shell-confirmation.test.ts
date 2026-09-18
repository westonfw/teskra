import { describe, expect, it } from 'vitest'

import type { WorkbenchEvents } from '@teskra/contracts'

import { createEventBus } from '../events/event-bus'
import { createShellConfirmationService } from './shell-confirmation'

// Silence the pino file/stdout logger (getLogger reads this lazily).
process.env['TESKRA_LOG_LEVEL'] = 'fatal'

/**
 * TASK-118: the shell-confirmation gate parks a repo-defined shell step until
 * the user answers; cancellation and shutdown never leave it hanging.
 */
describe('ShellConfirmationService (TASK-118)', () => {
  const details = {
    runId: 'run-1',
    stepId: 'step-1',
    nodeId: 'test-implement',
    command: 'npm run repo-script',
    cwd: '/repo',
  }

  it('emits the full command line and parks until resolve approves', async () => {
    const events = createEventBus<WorkbenchEvents>()
    const emitted: WorkbenchEvents['workflow.shell_confirmation_required'][] = []
    events.subscribe('workflow.shell_confirmation_required', (payload) => emitted.push(payload))
    const service = createShellConfirmationService({ events })

    let settled: boolean | undefined
    const parked = service.request(details).then((approved) => {
      settled = approved
    })
    // The event went out synchronously; the promise has not settled.
    expect(emitted).toEqual([details])
    await Promise.resolve()
    expect(settled).toBeUndefined()

    const resolved = service.resolve('step-1', true)
    expect(resolved).toEqual({ ok: true, data: true })
    await parked
    expect(settled).toBe(true)
  })

  it('rejects the step when the user declines', async () => {
    const service = createShellConfirmationService({ events: createEventBus<WorkbenchEvents>() })
    const parked = service.request(details)
    expect(service.resolve('step-1', false)).toEqual({ ok: true, data: true })
    await expect(parked).resolves.toBe(false)
  })

  it('reports an unknown step instead of hanging a second answer', async () => {
    const service = createShellConfirmationService({ events: createEventBus<WorkbenchEvents>() })
    const result = service.resolve('step-nope', true)
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })

  it('cancel settles the pending request as rejected', async () => {
    const service = createShellConfirmationService({ events: createEventBus<WorkbenchEvents>() })
    const parked = service.request(details)
    service.cancel('step-1')
    await expect(parked).resolves.toBe(false)
  })

  it('dispose rejects every parked request', async () => {
    const service = createShellConfirmationService({ events: createEventBus<WorkbenchEvents>() })
    const first = service.request(details)
    const second = service.request({ ...details, stepId: 'step-2' })
    service.dispose()
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
  })
})
