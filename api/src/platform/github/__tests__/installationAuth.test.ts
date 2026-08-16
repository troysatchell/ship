import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { signAppJwt, getInstallationAccessToken } from '../installationAuth.js'

function base64urlDecode(segment: string): Buffer {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64')
}

describe('signAppJwt', () => {
  let privateKey: string
  let publicKey: string

  beforeAll(() => {
    const keyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    privateKey = keyPair.privateKey
    publicKey = keyPair.publicKey
  })

  it('produces a JWT with the correct header, iss claim, and a valid RS256 signature', () => {
    const now = 1_700_000_000
    const jwt = signAppJwt({ appId: '123456', privateKey }, now)
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.')
    expect(encodedHeader).toBeDefined()
    expect(encodedPayload).toBeDefined()
    expect(encodedSignature).toBeDefined()

    const header = JSON.parse(base64urlDecode(encodedHeader as string).toString('utf8'))
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' })

    const payload = JSON.parse(base64urlDecode(encodedPayload as string).toString('utf8'))
    expect(payload.iss).toBe('123456')
    expect(payload.iat).toBe(now - 60)
    expect(payload.exp).toBe(now + 8 * 60)

    const signingInput = `${encodedHeader}.${encodedPayload}`
    const signatureBuf = base64urlDecode(encodedSignature as string)
    const verifier = createVerify('RSA-SHA256')
    verifier.update(signingInput)
    verifier.end()
    expect(verifier.verify(publicKey, signatureBuf)).toBe(true)
  })

  it('a signature verified against a DIFFERENT key pair fails (proves this is a real signature, not a fixed stub)', () => {
    const jwt = signAppJwt({ appId: '1', privateKey })
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.')
    const otherKeyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${encodedHeader}.${encodedPayload}`)
    verifier.end()
    expect(verifier.verify(otherKeyPair.publicKey, base64urlDecode(encodedSignature as string))).toBe(false)
  })
})

describe('getInstallationAccessToken', () => {
  it('POSTs to the correct GitHub endpoint with the App JWT as Bearer auth, and returns the token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe('https://api.github.com/app/installations/9999/access_tokens')
      expect(init?.method).toBe('POST')
      const headers = init?.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer fake-app-jwt')
      return new Response(JSON.stringify({ token: 'ghs_fake_installation_token' }), { status: 201 })
    })

    const token = await getInstallationAccessToken('fake-app-jwt', 9999, fetchMock)
    expect(token).toBe('ghs_fake_installation_token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws with a descriptive message on a non-2xx response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('installation not found', { status: 404 }))
    await expect(getInstallationAccessToken('fake-app-jwt', 1, fetchMock)).rejects.toThrow(/404/)
  })
})
