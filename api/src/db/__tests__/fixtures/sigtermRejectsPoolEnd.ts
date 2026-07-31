/**
 * Fixture process for clientShutdown.test.ts (TRO-297 / TS-10).
 *
 * NOT a test file itself (vitest's `include` only collects `src/**\/*.test.ts`)
 * — it is spawned as its own process specifically so it can call
 * `process.exit()` without taking down the test runner.
 *
 * Imports the real `pool` from client.ts, which registers the real
 * SIGTERM/SIGINT listeners as an import side effect, monkey-patches
 * `pool.end()` to reject, then calls `process.emit('SIGTERM')` — invoking the
 * registered listener directly and synchronously, rather than sending a real
 * OS signal (which would depend on delivery timing this fixture doesn't need
 * and can't control precisely).
 */
import { pool } from '../../client.js';

pool.end = () => Promise.reject(new Error('TRO-297 fixture: pool.end() rejected'));

process.emit('SIGTERM');
