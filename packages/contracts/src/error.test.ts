import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  ERROR_CODES,
  type ErrorCode,
  type IpcResult,
  errorCodeSchema,
  ipcResultSchema,
  publicAppErrorSchema,
  type PublicAppError,
} from './error'
import { z } from 'zod'

import * as contracts from './index'

describe('error model (teskra-tasks.md §0)', () => {
  it('PublicAppError carries no detail/cause; messageKey/params are optional', () => {
    expectTypeOf<PublicAppError>().toEqualTypeOf<{
      code: ErrorCode
      message: string
      retryable: boolean
      messageKey?: string | undefined
      params?: Record<string, string | number> | undefined
    }>()
    expectTypeOf<PublicAppError>().not.toHaveProperty('detail')
    expectTypeOf<PublicAppError>().not.toHaveProperty('cause')
  })

  it('publicAppErrorSchema rejects payloads carrying detail or cause (strict)', () => {
    const base = { code: 'UNKNOWN', message: 'boom', retryable: false }
    expect(publicAppErrorSchema.safeParse(base).success).toBe(true)
    expect(publicAppErrorSchema.safeParse({ ...base, detail: '/secret/path' }).success).toBe(false)
    expect(publicAppErrorSchema.safeParse({ ...base, cause: new Error('x') }).success).toBe(false)
  })

  it('messageKey / params survive the schema round-trip; omission stays valid', () => {
    const base = { code: 'WORKSPACE_NOT_FOUND', message: 'gone', retryable: false }
    expect(publicAppErrorSchema.safeParse(base).success).toBe(true)
    const keyed = publicAppErrorSchema.safeParse({
      ...base,
      messageKey: 'errorMessage.workspaceNotFound',
      params: { id: 'ws-1', attempts: 3 },
    })
    expect(keyed.success).toBe(true)
    if (keyed.success) {
      expect(keyed.data.messageKey).toBe('errorMessage.workspaceNotFound')
      expect(keyed.data.params).toEqual({ id: 'ws-1', attempts: 3 })
    }
    // Params values are string/number only — no nested objects across IPC.
    expect(
      publicAppErrorSchema.safeParse({ ...base, params: { id: { nested: true } } }).success,
    ).toBe(false)
  })

  it('IpcResult envelope cannot carry detail/cause through its schema either', () => {
    const schema = ipcResultSchema(z.string())
    expect(schema.safeParse({ ok: true, data: 'pong' }).success).toBe(true)
    expect(
      schema.safeParse({ ok: false, error: { code: 'UNKNOWN', message: 'x', retryable: true } })
        .success,
    ).toBe(true)
    expect(
      schema.safeParse({
        ok: false,
        error: { code: 'UNKNOWN', message: 'x', retryable: true, detail: 'leak' },
      }).success,
    ).toBe(false)
    expectTypeOf<IpcResult<string>>().toEqualTypeOf<
      { ok: true; data: string } | { ok: false; error: PublicAppError }
    >()
  })

  it('errorCodeSchema covers the §0 list', () => {
    expect(errorCodeSchema.options).toEqual([...ERROR_CODES])
  })

  it('InternalAppError is NOT exported from contracts (Main-side only)', () => {
    // Interfaces are erased at compile time, so this guards against anyone
    // adding a runtime export under that name; the type is also absent, which
    // makes `import { InternalAppError } from "@teskra/contracts"` a compile
    // error in the Renderer.
    expect('InternalAppError' in contracts).toBe(false)
    expect('toPublicError' in contracts).toBe(false)
  })
})
