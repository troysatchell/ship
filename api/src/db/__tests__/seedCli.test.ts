/**
 * Regression test for seed.ts's top-level call site (TRO-297 / TS-10).
 *
 * Mirrors migrateCli.test.ts's "top-level call site" case exactly, because
 * seed.ts has the identical shape: `await loadProductionSecrets()` (seed.ts:41)
 * runs BEFORE seed()'s own try/catch (seed.ts:52), so a rejection there used to
 * escape seed()'s error handling entirely and reach the bare top-level `seed();`
 * call (seed.ts's last line) as an unhandled promise rejection — a
 * `@typescript-eslint/no-floating-promises` violation, fixed by TRO-297 adding
 * `.catch(...)` to that call site.
 *
 * See migrateCli.test.ts for the detailed rationale behind each env var below
 * (NODE_ENV=production to reach loadProductionSecrets()'s SSM path at all,
 * empty DATABASE_URL/SESSION_SECRET to block seed.ts's own `.env.local`/`.env`
 * loading from re-populating them and letting ssm.ts's fallback swallow the
 * failure, AWS_ENDPOINT_URL_SSM pointed at an instantly-refusing local port so
 * ssm.ts's retry loop fails fast without touching real AWS).
 *
 * Spawns the real CLI (not a mock of process.exit) and asserts the failure is
 * reported through seed.ts's own "❌ Seed failed:" log line — the same line
 * its in-try catch block already uses — rather than escaping as an unhandled
 * rejection. Confirmed directly (not just inferred): temporarily reverting
 * seed.ts's top-level `.catch` back to a bare `seed();` call locally and
 * re-running this exact test goes red, with stderr instead containing Node's
 * own fatal unhandled-rejection trace and the raw ECONNREFUSED error, never
 * the "❌ Seed failed:" line.
 */
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = join(__dirname, '../../..');
const TSX_BIN = join(API_ROOT, 'node_modules/.bin/tsx');

describe('seed.ts CLI wrapper — top-level call site (TRO-297 / TS-10)', () => {
  it(
    "catches and reports a rejection from BEFORE its own try/catch, instead of an unhandled rejection",
    () => {
      const result = spawnSync(TSX_BIN, ['src/db/seed.ts'], {
        cwd: API_ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          DATABASE_URL: '',
          SESSION_SECRET: '',
          AWS_ENDPOINT_URL_SSM: 'http://127.0.0.1:1',
          AWS_ACCESS_KEY_ID: 'tro297-test-key',
          AWS_SECRET_ACCESS_KEY: 'tro297-test-secret',
          AWS_REGION: 'us-east-1',
          ENVIRONMENT: 'tro297test',
        },
        encoding: 'utf-8',
        timeout: 15_000,
      });

      expect(
        result.error,
        `spawning tsx failed outright (not a seed failure): ${result.error?.message}`
      ).toBeUndefined();
      expect(
        result.status,
        `seed.ts must exit non-zero when secrets cannot load. stderr:\n${result.stderr}`
      ).not.toBe(0);
      expect(
        result.stderr,
        'a rejection from loadProductionSecrets() (before seed()\'s own try/catch) must be caught and ' +
        'reported through the same "❌ Seed failed:" path as an in-try failure — not surface as an ' +
        'unhandled rejection'
      ).toMatch(/Seed failed/);
      expect(
        result.stderr,
        'must not reach the process as an unhandled rejection'
      ).not.toMatch(/unhandled ?rejection/i);
    },
    20_000
  );
});
