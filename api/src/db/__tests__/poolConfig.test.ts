/**
 * TRO-248 / RULE-7 — pool sizing and connection timeout were hardcoded
 * (`connectionTimeoutMillis: 2000`, `max: isProduction ? 20 : 10`) in
 * `client.ts`, with no way to raise them for a slow-starting managed
 * Postgres without a code change and a redeploy. `ssl.ts`'s file header
 * already documents the failure mode: a fixed 2000ms timeout against a
 * managed Postgres with a slow cold start turns a recoverable delay into a
 * crash-loop, because every connection attempt in that window fails outright.
 *
 * This file tests the pure decision function `resolvePoolTiming` in
 * isolation from `pg.Pool`, the same pattern `ssl.test.ts` uses for
 * `resolveDatabaseSsl` — importing `client.ts` directly would construct a
 * real `Pool` at module load.
 */
import { describe, it, expect } from 'vitest';
import { resolvePoolTiming } from '../poolConfig.js';

describe('resolvePoolTiming — defaults (TRO-248)', () => {
  it('keeps the previous hardcoded connection timeout when unset', () => {
    expect(resolvePoolTiming({}).connectionTimeoutMillis).toBe(2000);
  });

  it('keeps the previous hardcoded pool size for production and dev', () => {
    expect(resolvePoolTiming({ NODE_ENV: 'production' }).max).toBe(20);
    expect(resolvePoolTiming({ NODE_ENV: 'development' }).max).toBe(10);
    expect(resolvePoolTiming({}).max).toBe(10);
  });
});

describe('resolvePoolTiming — env overrides', () => {
  it('honors DB_POOL_CONNECTION_TIMEOUT_MS', () => {
    expect(
      resolvePoolTiming({ DB_POOL_CONNECTION_TIMEOUT_MS: '8000' }).connectionTimeoutMillis
    ).toBe(8000);
  });

  it('honors DB_POOL_MAX in production and DB_POOL_MAX_DEV elsewhere, independently', () => {
    expect(
      resolvePoolTiming({ NODE_ENV: 'production', DB_POOL_MAX: '40', DB_POOL_MAX_DEV: '2' }).max
    ).toBe(40);
    expect(
      resolvePoolTiming({ NODE_ENV: 'development', DB_POOL_MAX: '40', DB_POOL_MAX_DEV: '2' }).max
    ).toBe(2);
  });

  it('ignores DB_POOL_MAX_DEV in production and DB_POOL_MAX outside production', () => {
    // Cross-wiring these would size the wrong environment's pool from the
    // wrong knob with no error.
    expect(resolvePoolTiming({ NODE_ENV: 'production', DB_POOL_MAX_DEV: '99' }).max).toBe(20);
    expect(resolvePoolTiming({ NODE_ENV: 'development', DB_POOL_MAX: '99' }).max).toBe(10);
  });
});

describe('resolvePoolTiming — malformed overrides fall back to the default', () => {
  it.each([
    ['empty string', ''],
    ['non-numeric', 'abc'],
    ['zero', '0'],
    ['negative', '-100'],
  ])('%s DB_POOL_CONNECTION_TIMEOUT_MS falls back to 2000', (_label, value) => {
    expect(resolvePoolTiming({ DB_POOL_CONNECTION_TIMEOUT_MS: value }).connectionTimeoutMillis).toBe(
      2000
    );
  });

  it.each([
    ['empty string', ''],
    ['non-numeric', 'abc'],
    ['zero', '0'],
    ['negative', '-5'],
  ])('%s DB_POOL_MAX falls back to the production default', (_label, value) => {
    expect(resolvePoolTiming({ NODE_ENV: 'production', DB_POOL_MAX: value }).max).toBe(20);
  });
});
