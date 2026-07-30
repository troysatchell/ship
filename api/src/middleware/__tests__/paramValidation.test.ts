/**
 * Unit tests for the shared path/query validation added for TRO-192 (ERR-5)
 * and TRO-195 (ERR-8). See `api/src/routes/param-validation-regression.test.ts`
 * for the integration-level proof that these are actually wired into the
 * live routes; this file tests the helpers in isolation.
 */
import { describe, it, expect, vi } from 'vitest'
import type { NextFunction, Request, Response } from 'express'
import { validateUuidParam, limitQuerySchema } from '../paramValidation.js'

function makeRes(): Response {
  const res = {} as Response
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  return res
}

describe('validateUuidParam', () => {
  it('calls next() for a well-formed uuid', () => {
    const req = {} as Request
    const res = makeRes()
    const next = vi.fn() as NextFunction

    validateUuidParam(req, res, next, '550e8400-e29b-41d4-a716-446655440000', 'id')

    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('responds 400 and does not call next() for a malformed uuid', () => {
    const req = {} as Request
    const res = makeRes()
    const next = vi.fn() as NextFunction

    validateUuidParam(req, res, next, 'not-a-uuid', 'id')

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      error: 'Invalid input',
      details: [{ path: ['id'], message: 'Invalid uuid', code: 'invalid_string' }],
    })
  })

  it('reports the actual param name in the error path', () => {
    const req = {} as Request
    const res = makeRes()
    const next = vi.fn() as NextFunction

    validateUuidParam(req, res, next, 'not-a-number', 'weekId')

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ details: [expect.objectContaining({ path: ['weekId'] })] })
    )
  })
})

describe('limitQuerySchema', () => {
  const schema = limitQuerySchema(100)

  it('passes absent limit through as undefined (no behavior change for callers that omit it)', () => {
    const result = schema.safeParse(undefined)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBeUndefined()
  })

  it('accepts a positive integer within range', () => {
    const result = schema.safeParse('20')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe(20)
  })

  it('rejects a negative value', () => {
    const result = schema.safeParse('-1')
    expect(result.success).toBe(false)
  })

  it('rejects zero', () => {
    const result = schema.safeParse('0')
    expect(result.success).toBe(false)
  })

  it('rejects a non-numeric value', () => {
    const result = schema.safeParse('abc')
    expect(result.success).toBe(false)
  })

  it('clamps a value above max instead of rejecting it', () => {
    const result = schema.safeParse('999999999')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe(100)
  })

  it('clamps against whatever max the caller configures', () => {
    const smallSchema = limitQuerySchema(3)
    const result = smallSchema.safeParse('999999999')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe(3)
  })
})
