/**
 * Regression test for client.ts's SIGTERM/SIGINT listeners (TRO-297 / TS-10).
 *
 * These listeners used to be `async` functions passed directly to
 * `process.on(...)`:
 *
 *   process.on('SIGTERM', async () => {
 *     console.log(...);
 *     await pool.end();
 *     ...
 *   });
 *
 * — a `@typescript-eslint/no-misused-promises` violation. `process.on()` /
 * `EventEmitter` never awaits a listener's return value, so if `pool.end()`
 * ever rejected, the rejected promise the async listener returned had
 * nothing attached to it and escaped as an unhandled rejection during what
 * was supposed to be a graceful shutdown — turning a clean "pool didn't
 * close cleanly" log line into a raw crash trace instead.
 *
 * Runs fixtures/sigtermRejectsPoolEnd.ts, which imports the real `pool` from
 * client.ts (registering the real listeners), monkey-patches `pool.end()` to
 * reject, then calls `process.emit('SIGTERM')` — this invokes the exact
 * registered listener synchronously, without depending on OS signal-delivery
 * timing (and without sending a real signal to a live process, which the
 * vitest worker running this test cannot safely be on the receiving end of).
 *
 * Confirmed directly, not just inferred: reverting client.ts's listeners
 * back to the pre-fix `async () => { ...; await pool.end(); ... }` shape and
 * re-running this exact fixture goes red — the fixture process instead exits
 * via Node's fatal unhandled-rejection path, and stderr contains Node's own
 * trace rather than the "Error closing database pool on SIGTERM:" line this
 * test asserts on.
 */
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = join(__dirname, '../../..');
const TSX_BIN = join(API_ROOT, 'node_modules/.bin/tsx');
const FIXTURE = join(__dirname, 'fixtures/sigtermRejectsPoolEnd.ts');

describe('db/client.ts SIGTERM listener (TRO-297 / TS-10)', () => {
  it(
    'reports a pool.end() rejection during shutdown instead of an unhandled rejection',
    () => {
      const result = spawnSync(TSX_BIN, [FIXTURE], {
        cwd: API_ROOT,
        env: { ...process.env },
        encoding: 'utf-8',
        timeout: 10_000,
      });

      expect(
        result.error,
        `spawning tsx failed outright (not a shutdown failure): ${result.error?.message}`
      ).toBeUndefined();
      expect(
        result.status,
        `must exit non-zero when pool.end() rejects during shutdown. stderr:\n${result.stderr}`
      ).not.toBe(0);
      expect(
        result.stderr,
        'a pool.end() rejection during SIGTERM shutdown must be caught and logged through the ' +
        '"Error closing database pool on SIGTERM:" path, not surface as an unhandled rejection'
      ).toMatch(/Error closing database pool on SIGTERM/);
      expect(
        result.stderr,
        'must not reach the process as an unhandled rejection'
      ).not.toMatch(/unhandled ?rejection/i);
    },
    15_000
  );
});
