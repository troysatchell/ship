/**
 * Regression suite for TRO-433 / PF-303 (HMAC webhook signer).
 *
 * Test design source: Linear TRO-433 comment "Test design (pre-implementation — ship-test-designer,
 * 2026-08-10)". AC-1..AC-7 below map 1:1 onto that comment's numbering.
 *
 * This file also loads `shared/fixtures/webhook-signature-vectors.json` — the shared test-vector
 * fixture this ticket owns (PM triage comment, 2026-08-10) — and drives `sign`/`verify` through
 * every case in it, so this module is checked against the exact vectors PF-403's SDK-side
 * `verifyWebhook` will later consume for byte-parity.
 */

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createHmac, timingSafeEqual as timingSafeEqualUnderTest } from 'node:crypto'
import { sign, verify, DEFAULT_TOLERANCE_SECONDS, type Clock } from '../signer.js'

// `crypto.timingSafeEqual` is a read-only ESM export — `vi.spyOn` cannot redefine it directly
// ("Module namespace is not configurable in ESM"). Mocking the module and wrapping the real
// implementation in `vi.fn` is the supported way to observe calls to it while keeping its actual
// behavior for every other assertion in this file (including the perf and fixture tests below,
// which all go through the same `verify()` call path).
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    timingSafeEqual: vi.fn(actual.timingSafeEqual),
  }
})

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = resolve(__dirname, '../../../../../shared/fixtures/webhook-signature-vectors.json')

interface FixtureCase {
  name: string
  description: string
  secret: string
  rawBody: string
  verifyRawBody: string
  signTimestamp: number
  verifyTimestamp: number
  toleranceSeconds: number
  header: string
  expectedValid: boolean
}

interface Fixture {
  cases: FixtureCase[]
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Fixture
}

function clockAt(t: number): Clock {
  return () => t
}

describe('platform/webhooks/signer', () => {
  const SECRET = 'unit-test-secret-not-a-real-credential'
  const RAW_BODY = '{"event":"document.created","id":"doc_1"}'
  const T = 1_700_000_000

  // AC-1: positive case
  it('verifies a signature freshly signed for the same body and timestamp', () => {
    const clock = clockAt(T)
    const header = sign(RAW_BODY, SECRET, clock)

    expect(header).toBe(
      `t=${T},v1=${createHmac('sha256', SECRET).update(`${T}.${RAW_BODY}`).digest('hex')}`,
    )
    expect(verify(header, RAW_BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, clock)).toBe(true)
  })

  // AC-2: tampered body
  it('rejects verification against a body different from the one that was signed', () => {
    const clock = clockAt(T)
    const header = sign(RAW_BODY, SECRET, clock)
    const tamperedBody = '{"event":"document.created","id":"doc_1","extra":"injected"}'

    expect(verify(header, tamperedBody, SECRET, DEFAULT_TOLERANCE_SECONDS, clock)).toBe(false)
  })

  // AC-3: expired timestamp
  it('rejects a signature signed outside the tolerance window', () => {
    const signClock = clockAt(T - 400) // 400s before verification — beyond default 300s tolerance
    const header = sign(RAW_BODY, SECRET, signClock)

    const verifyClock = clockAt(T)
    expect(verify(header, RAW_BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, verifyClock)).toBe(false)
  })

  // AC-4: missing v1
  it('rejects a header with no v1 component, without throwing', () => {
    const header = `t=${T}`
    const clock = clockAt(T)

    expect(() => verify(header, RAW_BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, clock)).not.toThrow()
    expect(verify(header, RAW_BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, clock)).toBe(false)
  })

  // AC-5: clock-skew tolerance boundary (inclusive at exactly 300s, false at 301s)
  describe('tolerance boundary', () => {
    it('accepts a signature exactly at the 300s boundary (inclusive)', () => {
      const signClock = clockAt(T - 300)
      const header = sign(RAW_BODY, SECRET, signClock)

      const verifyClock = clockAt(T)
      expect(verify(header, RAW_BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, verifyClock)).toBe(true)
    })

    it('rejects a signature one second past the 300s boundary', () => {
      const signClock = clockAt(T - 301)
      const header = sign(RAW_BODY, SECRET, signClock)

      const verifyClock = clockAt(T)
      expect(verify(header, RAW_BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, verifyClock)).toBe(false)
    })
  })

  // AC-6: signing < 1ms (generous CI-safe ceiling per test-design convention #9)
  it('signs in well under a generous CI-safe ceiling (target: < 1ms, asserted at < 5ms mean)', () => {
    const clock = clockAt(T)

    // Warmup — avoid JIT cold-start skew.
    for (let i = 0; i < 100; i++) {
      sign(RAW_BODY, SECRET, clock)
    }

    const iterations = 1000
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      sign(RAW_BODY, SECRET, clock)
    }
    const elapsed = performance.now() - start
    const meanMs = elapsed / iterations

    // Target per PLUGFORGE.MD §4 PF-303 AC is < 1ms; asserted against a generous 5ms ceiling to
    // avoid runner-load flake (see this file's header comment / TRO-433 test-design convention #9).
    expect(meanMs).toBeLessThan(5)
  })

  // AC-7: constant-time compare (test-design convention #5 — proves the API used, not measured
  // timing uniformity, which convention #5 explicitly forbids as flake-prone).
  describe('constant-time compare', () => {
    it('invokes crypto.timingSafeEqual during a valid verify', () => {
      const clock = clockAt(T)
      const header = sign(RAW_BODY, SECRET, clock)

      const mockedTimingSafeEqual = vi.mocked(timingSafeEqualUnderTest)
      const callsBefore = mockedTimingSafeEqual.mock.calls.length

      verify(header, RAW_BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, clock)

      expect(mockedTimingSafeEqual.mock.calls.length).toBeGreaterThan(callsBefore)
    })

    it('rejects both a one-byte-different and a completely different signature', () => {
      const clock = clockAt(T)
      const header = sign(RAW_BODY, SECRET, clock)
      const [tPart, v1Part] = header.split(',')
      const v1 = v1Part.slice('v1='.length)

      const flippedLastChar = v1.slice(0, -1) + (v1.at(-1) === '0' ? '1' : '0')
      const oneByteDifferentHeader = `${tPart},v1=${flippedLastChar}`
      expect(verify(oneByteDifferentHeader, RAW_BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, clock)).toBe(
        false,
      )

      const completelyDifferentHeader = `${tPart},v1=${'f'.repeat(v1.length)}`
      expect(
        verify(completelyDifferentHeader, RAW_BODY, SECRET, DEFAULT_TOLERANCE_SECONDS, clock),
      ).toBe(false)
    })
  })

  describe('shared fixture (shared/fixtures/webhook-signature-vectors.json)', () => {
    const fixture = loadFixture()

    it('has at least the five case families the fixture-ownership PM comment requires', () => {
      const names = fixture.cases.map((c) => c.name)
      expect(names).toContain('valid')
      expect(names).toContain('tampered')
      expect(names).toContain('expired')
      expect(names).toContain('missing_v1')
      expect(names.some((n) => n.startsWith('boundary'))).toBe(true)
    })

    it.each(
      // Loaded once above; expanded here so each case reports as its own test result.
      (() => loadFixture().cases)(),
    )('case "$name": $description', (testCase: FixtureCase) => {
      // sign() reproduces the fixture's own header exactly, given the same inputs — this is what
      // makes the fixture usable as a byte-parity check against an independent implementation.
      const signedHeader = sign(testCase.rawBody, testCase.secret, clockAt(testCase.signTimestamp))
      if (testCase.header.includes('v1=')) {
        expect(signedHeader).toBe(testCase.header)
      }

      const result = verify(
        testCase.header,
        testCase.verifyRawBody,
        testCase.secret,
        testCase.toleranceSeconds,
        clockAt(testCase.verifyTimestamp),
      )
      expect(result).toBe(testCase.expectedValid)
    })
  })
})
