/**
 * Regression suite for TRO-413 / PF-403 (`@ship/sdk`'s `verifyWebhook`).
 *
 * AC source: PLUGFORGE.MD §2.8's one-line spec, expanded per the ticket brief's AC list — "valid
 * passes; tampered fails; > 5-min-old fails; missing v1 fails; < 1 ms per call (perf test)" — plus
 * the hardening cases already proven server-side by `api/src/platform/webhooks/signer.test.ts`
 * (malformed-hex `v1`, fail-closed tolerance/clock guards, constant-time compare), ported here
 * since this file is the byte-identical port of that algorithm.
 *
 * This file also loads `shared/fixtures/webhook-signature-vectors.json` — the fixture PF-303
 * created specifically so PF-403 doesn't reinvent test cases — and drives `verifyWebhook` through
 * every case in it, so this module is checked against the exact vectors the server-side signer's
 * own suite uses, for byte-parity.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHmac, timingSafeEqual as timingSafeEqualUnderTest } from 'node:crypto';
import { verifyWebhook, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, SHIP_SIGNATURE_HEADER_NAME } from './verifyWebhook.js';

// `crypto.timingSafeEqual` is a read-only ESM export — `vi.spyOn` cannot redefine it directly
// ("Module namespace is not configurable in ESM"). Mocking the module and wrapping the real
// implementation in `vi.fn` is the supported way to observe calls to it while keeping its actual
// behavior for every other assertion in this file (including the perf and fixture tests below,
// which all go through the same `verifyWebhook()` call path). Mirrors signer.test.ts's identical
// setup.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: vi.fn(actual.timingSafeEqual),
  };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, '../../shared/fixtures/webhook-signature-vectors.json');

interface FixtureCase {
  name: string;
  description: string;
  secret: string;
  rawBody: string;
  verifyRawBody: string;
  signTimestamp: number;
  verifyTimestamp: number;
  toleranceSeconds: number;
  header: string;
  expectedValid: boolean;
  headerReproducibleBySign: boolean;
}

interface Fixture {
  cases: FixtureCase[];
}

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Fixture;
}

/** Builds a real `Ship-Signature` header value the same way `signer.ts`'s `sign()` does, so this
 *  test file doesn't need to import across the api/sdk package boundary to get one. */
function buildHeader(t: number, rawBody: string, secret: string): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

describe('verifyWebhook', () => {
  const SECRET = 'unit-test-secret-not-a-real-credential';
  const RAW_BODY = '{"event":"document.created","id":"doc_1"}';
  const T = 1_700_000_000;

  // AC: valid signature passes.
  it('verifies a signature freshly signed for the same body and timestamp', () => {
    const header = buildHeader(T, RAW_BODY, SECRET);
    const headers = { 'Ship-Signature': header };

    expect(verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(true);
  });

  // Proves the real-clock default path (no `now` override) also works — not just the
  // deterministic test-only path every other case in this file uses.
  it('verifies against the real wall clock when `now` is omitted', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = buildHeader(nowSeconds, RAW_BODY, SECRET);
    const headers = { 'Ship-Signature': header };

    expect(verifyWebhook(headers, RAW_BODY, SECRET)).toBe(true);
  });

  // AC: tampered body fails.
  it('rejects verification against a body different from the one that was signed', () => {
    const header = buildHeader(T, RAW_BODY, SECRET);
    const headers = { 'Ship-Signature': header };
    const tamperedBody = '{"event":"document.created","id":"doc_1","extra":"injected"}';

    expect(verifyWebhook(headers, tamperedBody, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(false);
  });

  // AC: > 5-min-old (default 300s tolerance) fails.
  it('rejects a signature signed outside the tolerance window', () => {
    const header = buildHeader(T - 400, RAW_BODY, SECRET); // 400s before verification
    const headers = { 'Ship-Signature': header };

    expect(verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(false);
  });

  // AC: missing v1 fails, without throwing.
  it('rejects a header with no v1 component, without throwing', () => {
    const headers = { 'Ship-Signature': `t=${T}` };

    expect(() => verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).not.toThrow();
    expect(verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(false);
  });

  it('rejects a request with no Ship-Signature header at all, without throwing', () => {
    expect(() => verifyWebhook({}, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).not.toThrow();
    expect(verifyWebhook({}, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(false);
  });

  describe('header input shapes', () => {
    it('accepts a plain Record<string,string> with lower-cased keys (Node req.headers convention)', () => {
      const header = buildHeader(T, RAW_BODY, SECRET);
      const headers = { 'ship-signature': header };

      expect(verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(true);
    });

    it('accepts a standard Headers object, case-insensitively', () => {
      const header = buildHeader(T, RAW_BODY, SECRET);
      const headers = new Headers({ 'SHIP-SIGNATURE': header });

      expect(verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(true);
    });

    it('accepts a Buffer rawBody equivalent to the signed UTF-8 string', () => {
      const header = buildHeader(T, RAW_BODY, SECRET);
      const headers = { 'Ship-Signature': header };
      const bufferBody = Buffer.from(RAW_BODY, 'utf8');

      expect(verifyWebhook(headers, bufferBody, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(true);
    });

    // Regression tests for a CodeRabbit finding on this ticket: the original `headers` type
    // (`Record<string,string>`) doesn't actually match Node's real `http.IncomingMessage.headers`
    // (`IncomingHttpHeaders` — values can be `string | string[] | undefined`), so a real webhook
    // receiver's most natural call site, `verifyWebhook(req.headers, ...)`, wouldn't type-check.
    // Broadened to accept that shape directly. An array value (a duplicated header — never
    // expected for `Ship-Signature` in practice) or an `undefined` value must fail closed rather
    // than guessing which entry was meant.
    it('accepts a Node IncomingHttpHeaders-shaped object with an unrelated array-valued header alongside it', () => {
      const header = buildHeader(T, RAW_BODY, SECRET);
      const headers = { 'ship-signature': header, 'set-cookie': ['a=1', 'b=2'] };

      expect(verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(true);
    });

    it('fails closed when Ship-Signature itself is array-valued, without throwing', () => {
      const header = buildHeader(T, RAW_BODY, SECRET);
      const headers = { 'ship-signature': [header, header] };

      expect(() => verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).not.toThrow();
      expect(verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(false);
    });

    it('fails closed when Ship-Signature is present but undefined, without throwing', () => {
      const headers: Record<string, string | string[] | undefined> = { 'ship-signature': undefined };

      expect(() => verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).not.toThrow();
      expect(verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(false);
    });

    // Regression test for a CodeRabbit finding on this ticket: an earlier version normalized a
    // Buffer rawBody via `.toString('utf8')` before hashing, which is lossy for bytes that are
    // NOT valid UTF-8 (decode replaces invalid sequences with U+FFFD; re-encoding that string
    // then hashes different bytes than the ones actually signed). The fix hashes the raw bytes
    // directly. This body deliberately contains an invalid UTF-8 byte sequence (a lone 0xFF 0xFE)
    // so the two approaches provably diverge — the digest computed the OLD (decode-first) way is
    // asserted different from the correct one, proving this isn't a coincidental pass.
    it('verifies a Buffer rawBody containing bytes that are not valid UTF-8, hashed as raw bytes', () => {
      const invalidUtf8Body = Buffer.from([
        0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d, // {"id":"<invalid>"}
      ]);

      const correctDigest = createHmac('sha256', SECRET)
        .update(Buffer.concat([Buffer.from(`${T}.`, 'utf8'), invalidUtf8Body]))
        .digest('hex');
      const lossyDigest = createHmac('sha256', SECRET)
        .update(`${T}.${invalidUtf8Body.toString('utf8')}`)
        .digest('hex');
      expect(correctDigest).not.toBe(lossyDigest); // sanity: the two approaches really do diverge

      const headers = { 'Ship-Signature': `t=${T},v1=${correctDigest}` };
      expect(verifyWebhook(headers, invalidUtf8Body, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(true);

      const lossyHeaders = { 'Ship-Signature': `t=${T},v1=${lossyDigest}` };
      expect(verifyWebhook(lossyHeaders, invalidUtf8Body, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(
        false,
      );
    });
  });

  // Hardening ported from signer.test.ts (TRO-433 / gate.sh G9): `Buffer.from(str, 'hex')` does
  // not throw on invalid hex — it silently stops decoding at the first invalid character. A `v1`
  // consisting of a genuinely valid 64-char digest with extra garbage appended still decodes to
  // exactly 32 bytes (Node truncates right after the valid digest), the same length as a real
  // digest, so a length-only check cannot tell it apart from a real, unmodified signature.
  it('rejects a v1 with a genuinely valid digest plus trailing garbage, without throwing', () => {
    const validHeader = buildHeader(T, RAW_BODY, SECRET);
    const headerParts = validHeader.split(',');
    const tPart = headerParts[0];
    const v1Part = headerParts[1];
    if (tPart === undefined || v1Part === undefined) {
      throw new Error(`test setup produced an unparseable header: "${validHeader}"`);
    }
    const realV1 = v1Part.slice('v1='.length);

    const trailingGarbageHeader = `${tPart},v1=${realV1}zzzz`;
    const headers = { 'Ship-Signature': trailingGarbageHeader };

    expect(() => verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).not.toThrow();
    expect(verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(false);

    // Sanity companions: length-mismatched malformed values were already rejected before this
    // guard existed, and stay rejected — this guard adds coverage, it doesn't replace the old path.
    const tooShort = { 'Ship-Signature': `${tPart},v1=${'a'.repeat(10)}` };
    const allInvalid = { 'Ship-Signature': `${tPart},v1=${'z'.repeat(64)}` };
    for (const malformed of [tooShort, allInvalid]) {
      expect(verifyWebhook(malformed, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(false);
    }
  });

  // Hardening ported from signer.test.ts: `Math.abs(now - t) > toleranceSeconds` fails OPEN for
  // non-finite operands (`NaN > x` is always `false`), so a misconfigured tolerance must be
  // rejected explicitly rather than silently disabling the replay-protection window.
  it('rejects non-finite or negative toleranceSec instead of failing open', () => {
    const header = buildHeader(T, RAW_BODY, SECRET);
    const headers = { 'Ship-Signature': header };

    expect(verifyWebhook(headers, RAW_BODY, SECRET, Number.NaN, T)).toBe(false);
    expect(verifyWebhook(headers, RAW_BODY, SECRET, Number.POSITIVE_INFINITY, T)).toBe(false);
    expect(verifyWebhook(headers, RAW_BODY, SECRET, -1, T)).toBe(false);
  });

  // Divergence from signer.ts's verify() (documented in verifyWebhook.ts's header comment):
  // never throws, even for an empty secret — the vulnerability signer.ts's throw-based guard
  // exists for (an empty/guessable key must never verify `true`) is still closed, just via the
  // `false` return path instead of an exception.
  it('rejects an empty secret without throwing, and never verifies true under one', () => {
    const header = buildHeader(T, RAW_BODY, ''); // signed with the same empty secret
    const headers = { 'Ship-Signature': header };

    expect(() => verifyWebhook(headers, RAW_BODY, '', DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).not.toThrow();
    expect(verifyWebhook(headers, RAW_BODY, '', DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(false);
  });

  // Tolerance boundary — inclusive at exactly 300s, false at 301s.
  describe('tolerance boundary', () => {
    it('accepts a signature exactly at the 300s boundary (inclusive)', () => {
      const header = buildHeader(T - 300, RAW_BODY, SECRET);
      const headers = { 'Ship-Signature': header };

      expect(verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(true);
    });

    it('rejects a signature one second past the 300s boundary', () => {
      const header = buildHeader(T - 301, RAW_BODY, SECRET);
      const headers = { 'Ship-Signature': header };

      expect(verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T)).toBe(false);
    });

    it('respects a caller-supplied non-default toleranceSec', () => {
      const header = buildHeader(T - 60, RAW_BODY, SECRET);
      const headers = { 'Ship-Signature': header };

      expect(verifyWebhook(headers, RAW_BODY, SECRET, 30, T)).toBe(false);
      expect(verifyWebhook(headers, RAW_BODY, SECRET, 120, T)).toBe(true);
    });
  });

  // AC: < 1ms per call (perf test). Target per PLUGFORGE.MD §2.8/§4 is < 1ms; asserted against a
  // generous 5ms mean ceiling to avoid runner-load flake — same CI-safe-ceiling convention
  // signer.test.ts uses for sign()'s own perf assertion (see that file's comment). The actual
  // measured mean is reported in the PR body's evidence table, not asserted at 1ms directly,
  // because CI-runner variance makes a tight assertion flaky, not because the target isn't met.
  it('verifies in well under a generous CI-safe ceiling (target: < 1ms, asserted at < 5ms mean)', () => {
    const header = buildHeader(T, RAW_BODY, SECRET);
    const headers = { 'Ship-Signature': header };

    // Warmup — avoid JIT cold-start skew.
    for (let i = 0; i < 100; i++) {
      verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T);
    }

    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T);
    }
    const elapsed = performance.now() - start;
    const meanMs = elapsed / iterations;

    expect(meanMs).toBeLessThan(5);
  });

  // AC: constant-time compare (proves the API used, not measured timing uniformity, which is
  // flake-prone and explicitly avoided here — mirrors signer.test.ts's identical convention).
  describe('constant-time compare', () => {
    it('invokes crypto.timingSafeEqual during a valid verify', () => {
      const header = buildHeader(T, RAW_BODY, SECRET);
      const headers = { 'Ship-Signature': header };

      const mockedTimingSafeEqual = vi.mocked(timingSafeEqualUnderTest);
      const callsBefore = mockedTimingSafeEqual.mock.calls.length;

      verifyWebhook(headers, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T);

      expect(mockedTimingSafeEqual.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it('rejects both a one-byte-different and a completely different signature', () => {
      const header = buildHeader(T, RAW_BODY, SECRET);
      const headerParts = header.split(',');
      const tPart = headerParts[0];
      const v1Part = headerParts[1];
      if (tPart === undefined || v1Part === undefined) {
        throw new Error(`test setup produced an unparseable header: "${header}"`);
      }
      const v1 = v1Part.slice('v1='.length);

      const flippedLastChar = v1.slice(0, -1) + (v1.at(-1) === '0' ? '1' : '0');
      const oneByteDifferentHeaders = { 'Ship-Signature': `${tPart},v1=${flippedLastChar}` };
      expect(
        verifyWebhook(oneByteDifferentHeaders, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T),
      ).toBe(false);

      const completelyDifferentHeaders = { 'Ship-Signature': `${tPart},v1=${'f'.repeat(v1.length)}` };
      expect(
        verifyWebhook(completelyDifferentHeaders, RAW_BODY, SECRET, DEFAULT_WEBHOOK_TOLERANCE_SECONDS, T),
      ).toBe(false);
    });
  });

  describe('shared fixture (shared/fixtures/webhook-signature-vectors.json)', () => {
    const fixture = loadFixture();

    it('has at least the five case families the fixture-ownership PM comment requires', () => {
      const names = fixture.cases.map((c) => c.name);
      expect(names).toContain('valid');
      expect(names).toContain('tampered');
      expect(names).toContain('expired');
      expect(names).toContain('missing_v1');
      expect(names.some((n) => n.startsWith('boundary'))).toBe(true);
    });

    // Expanded from the fixture loaded above, so each case reports as its own test result. Drives
    // `verifyWebhook` directly against the fixture's raw `header` string (via the `now` test-only
    // injection point, pinned to the fixture's own `verifyTimestamp`) and the same
    // `toleranceSeconds` the fixture case specifies — the strongest available proof this port is
    // byte-identical to the server-side signer's algorithm, since both consume one shared,
    // independently-generated source of truth.
    it.each(fixture.cases)('case "$name": $description', (testCase: FixtureCase) => {
      expect(typeof testCase.headerReproducibleBySign).toBe('boolean');

      const headers = { [SHIP_SIGNATURE_HEADER_NAME]: testCase.header };
      const result = verifyWebhook(
        headers,
        testCase.verifyRawBody,
        testCase.secret,
        testCase.toleranceSeconds,
        testCase.verifyTimestamp,
      );
      expect(result).toBe(testCase.expectedValid);
    });
  });
});
