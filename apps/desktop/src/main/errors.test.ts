import { describe, expect, expectTypeOf, it } from 'vitest'

import { type AppErrorLogger, type InternalAppError, setErrorLogger, toPublicError } from './errors'

describe('toPublicError (teskra-tasks.md §0)', () => {
  it('strips detail / cause from the public shape', () => {
    const internal: InternalAppError = {
      code: 'COMMAND_TIMEOUT',
      message: 'The command timed out.',
      retryable: true,
      detail: 'stderr: ...',
      cause: new Error('spawn failure'),
    }
    const publicError = toPublicError(internal, 'corr-1')
    expect(publicError).toEqual({
      code: 'COMMAND_TIMEOUT',
      message: 'The command timed out.',
      retryable: true,
    })
    expect('detail' in publicError).toBe(false)
    expect('cause' in publicError).toBe(false)
    expectTypeOf(publicError).not.toHaveProperty('detail')
    expectTypeOf(publicError).not.toHaveProperty('cause')
  })

  it('passes messageKey / params through when present', () => {
    const publicError = toPublicError(
      {
        code: 'WORKSPACE_NOT_FOUND',
        message: 'Workspace "ws-1" was not found.',
        messageKey: 'errorMessage.workspaceNotFound',
        params: { id: 'ws-1' },
        retryable: false,
      },
      'corr-3',
    )
    expect(publicError).toEqual({
      code: 'WORKSPACE_NOT_FOUND',
      message: 'Workspace "ws-1" was not found.',
      messageKey: 'errorMessage.workspaceNotFound',
      params: { id: 'ws-1' },
      retryable: false,
    })
    expect('detail' in publicError).toBe(false)
  })

  it('logs detail / cause with correlationId through the injected logger', () => {
    const records: Array<{ record: Record<string, unknown>; message: string }> = []
    const logger: AppErrorLogger = {
      error: (record, message) => records.push({ record, message }),
    }
    setErrorLogger(logger)

    toPublicError(
      { code: 'UNKNOWN', message: 'boom', retryable: false, detail: 'd', cause: new Error('c') },
      'corr-2',
    )

    expect(records).toHaveLength(1)
    expect(records[0]?.message).toBe('boom')
    expect(records[0]?.record['correlationId']).toBe('corr-2')
    expect(records[0]?.record['detail']).toBe('d')
    expect(records[0]?.record['cause']).toMatchObject({ name: 'Error', message: 'c' })
  })
})
