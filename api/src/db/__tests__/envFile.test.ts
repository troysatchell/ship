/**
 * Regression test for TEST-9 / TRO-231 — `pnpm test` used to TRUNCATE
 * whatever database `DATABASE_URL` pointed at, because `client.ts`
 * unconditionally loaded `api/.env.local` (the exact file `scripts/dev.sh`
 * writes with a developer's dev database) before `api/src/test/setup.ts`'s
 * `beforeAll` ran its `TRUNCATE ... CASCADE`.
 *
 * This tests the extracted pure decision function `resolveEnvFilesToLoad`
 * directly — no filesystem, no dotenv, no database — rather than importing
 * `client.ts` itself, which has real module-load side effects (constructing a
 * `pg.Pool`, registering `SIGTERM`/`SIGINT` listeners; see
 * `clientShutdown.test.ts` for why that import is avoided in tests, same
 * reasoning `ssl.test.ts`/`poolConfig.test.ts` already follow for their own
 * extracted pure functions).
 *
 * Red-before-green, confirmed directly: run this file against the pre-fix
 * `client.ts` shape — i.e. against a version of `resolveEnvFilesToLoad` that
 * unconditionally returns `[{ path: envLocalPath, override: false }, { path:
 * envPath, override: false }]` regardless of `isVitest`/`envTestExists` (the
 * old inline `config()` calls' actual behavior) — and the
 * "does NOT fall back to .env.local" case below fails: it asserts
 * `.env.local` is absent from the plan, and the old behavior always includes
 * it first.
 *
 * `process.env.VITEST` is genuinely set by the test runner, not assumed:
 * verified in this file's own describe block below by asserting on the real
 * `process.env.VITEST` vitest set for this very test run (see vitest's
 * `prepareVitest()` in `node_modules/vitest/dist/chunks/cli-api.*.js`, which
 * sets `process.env.VITEST = 'true'` before any test file loads, and passes
 * `VITEST: 'true'` in the `env` given to every worker process it spawns).
 */
import { describe, it, expect } from 'vitest';
import { resolveEnvFilesToLoad } from '../envFile.js';

const ENV_LOCAL = '/repo/api/.env.local';
const ENV = '/repo/api/.env';
const ENV_TEST = '/repo/api/.env.test';

describe('process.env.VITEST — the signal this fix depends on', () => {
  it('is genuinely set by the test runner (not assumed from the ticket brief)', () => {
    // If this ever stops being true, resolveEnvFilesToLoad's caller
    // (client.ts) would fall through to the "not vitest" branch during real
    // test runs and the TEST-9 fix would silently stop applying.
    expect(process.env.VITEST).toBe('true');
  });
});

describe('resolveEnvFilesToLoad — under vitest', () => {
  it('loads ONLY .env.test, with override:true, when .env.test exists', () => {
    const plan = resolveEnvFilesToLoad({
      isVitest: true,
      envTestExists: true,
      envLocalPath: ENV_LOCAL,
      envPath: ENV,
      envTestPath: ENV_TEST,
    });

    expect(plan).toEqual([{ path: ENV_TEST, override: true }]);
  });

  it('does NOT fall back to .env.local (or .env) when .env.test is missing', () => {
    const plan = resolveEnvFilesToLoad({
      isVitest: true,
      envTestExists: false,
      envLocalPath: ENV_LOCAL,
      envPath: ENV,
      envTestPath: ENV_TEST,
    });

    // This is the core TEST-9 guarantee: under vitest, .env.local's dev
    // DATABASE_URL must never be loaded — whether or not a real .env.test
    // is present. Loading nothing leaves DATABASE_URL to whatever the
    // environment already provided (.factory-env, CI's CI_DATABASE_URL, or
    // an explicit developer export).
    expect(plan).toEqual([]);
    expect(plan.some((p) => p.path === ENV_LOCAL)).toBe(false);
    expect(plan.some((p) => p.path === ENV)).toBe(false);
  });
});

describe('resolveEnvFilesToLoad — not under vitest (pnpm dev, production)', () => {
  it('loads .env.local then .env, neither overriding, regardless of .env.test', () => {
    const withEnvTest = resolveEnvFilesToLoad({
      isVitest: false,
      envTestExists: true,
      envLocalPath: ENV_LOCAL,
      envPath: ENV,
      envTestPath: ENV_TEST,
    });
    const withoutEnvTest = resolveEnvFilesToLoad({
      isVitest: false,
      envTestExists: false,
      envLocalPath: ENV_LOCAL,
      envPath: ENV,
      envTestPath: ENV_TEST,
    });

    const expected = [
      { path: ENV_LOCAL, override: false },
      { path: ENV, override: false },
    ];
    // Preserves pnpm dev's pre-existing behavior byte-for-byte: .env.test's
    // existence is irrelevant outside vitest.
    expect(withEnvTest).toEqual(expected);
    expect(withoutEnvTest).toEqual(expected);
  });
});
