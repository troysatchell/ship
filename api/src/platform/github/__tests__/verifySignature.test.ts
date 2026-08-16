import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyGithubSignature, GITHUB_SIGNATURE_HEADER_NAME } from '../verifySignature.js'

const SECRET = 'a-fixture-github-webhook-secret'

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

describe('verifyGithubSignature', () => {
  it('accepts a correctly signed body', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }))
    const headers = { [GITHUB_SIGNATURE_HEADER_NAME]: sign(body) }
    expect(verifyGithubSignature(headers, body, SECRET)).toBe(true)
  })

  it('rejects a body signed under a different secret', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }))
    const headers = { [GITHUB_SIGNATURE_HEADER_NAME]: sign(body, 'wrong-secret') }
    expect(verifyGithubSignature(headers, body, SECRET)).toBe(false)
  })

  it('rejects when the body has been tampered with after signing', () => {
    const originalBody = Buffer.from(JSON.stringify({ hello: 'world' }))
    const headers = { [GITHUB_SIGNATURE_HEADER_NAME]: sign(originalBody) }
    const tamperedBody = Buffer.from(JSON.stringify({ hello: 'tampered' }))
    expect(verifyGithubSignature(headers, tamperedBody, SECRET)).toBe(false)
  })

  it('rejects a missing signature header', () => {
    const body = Buffer.from('{}')
    expect(verifyGithubSignature({}, body, SECRET)).toBe(false)
  })

  it('rejects a header missing the sha256= prefix', () => {
    const body = Buffer.from('{}')
    const headers = { [GITHUB_SIGNATURE_HEADER_NAME]: createHmac('sha256', SECRET).update(body).digest('hex') }
    expect(verifyGithubSignature(headers, body, SECRET)).toBe(false)
  })

  it('rejects a non-hex digest', () => {
    const body = Buffer.from('{}')
    const headers = { [GITHUB_SIGNATURE_HEADER_NAME]: 'sha256=not-hex-at-all' }
    expect(verifyGithubSignature(headers, body, SECRET)).toBe(false)
  })

  it('rejects a duplicated (array-valued) header rather than guessing', () => {
    const body = Buffer.from('{}')
    const headers = { [GITHUB_SIGNATURE_HEADER_NAME]: [sign(body), sign(body)] }
    expect(verifyGithubSignature(headers, body, SECRET)).toBe(false)
  })

  it('throws for an empty secret rather than silently verifying against it', () => {
    const body = Buffer.from('{}')
    expect(() => verifyGithubSignature({}, body, '')).toThrow(TypeError)
  })
})
