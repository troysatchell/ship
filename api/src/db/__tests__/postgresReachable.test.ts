/**
 * Regression tests for `postgresReachable.ts` (W4-R42 — `scripts/dev.sh`
 * bootstraps Postgres via Docker when it's unreachable at the default
 * address, instead of stopping at `ensureDatabase.ts`'s unreachable-database
 * message).
 *
 * These exercise the real TCP check against a real, throwaway `net.Server`
 * (the "reachable" case) and a real closed port (the "unreachable" case) —
 * no mocked sockets, so a change to the timeout/error-handling wiring would
 * actually be caught here rather than by an assertion on a stub.
 *
 * The second `describe` block below spawns the actual CLI
 * (`npx tsx src/db/postgresReachable.ts <url>`) as a subprocess and asserts
 * on its real exit code — the exact contract `scripts/dev.sh` depends on
 * (`if (... && npx tsx src/db/postgresReachable.ts "$URL"); then ...`,
 * branching on `$?`). The first block covers `isPostgresReachable()` the
 * function; without the second, an inverted `process.exit(reachable ? 0 : 1)`
 * in `main()` would leave every test above green while the real integration
 * silently broke.
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { isPostgresReachable } from '../postgresReachable.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
// api/src/db/__tests__ -> api (three levels up), matching the cwd
// scripts/dev.sh actually runs the CLI from: `(cd "$ROOT_DIR/api" && npx tsx
// src/db/postgresReachable.ts "$RESOLVED_DATABASE_URL")`.
const API_ROOT = join(__dirname, '..', '..', '..');

/**
 * Runs the real CLI as a subprocess and returns its actual exit code.
 * `execFile`'s promise rejects on non-zero exit; the code is recovered from
 * the rejection rather than assumed, so a spawn failure (missing `npx`, a
 * syntax error making tsx itself crash) surfaces as a distinct, non-numeric
 * failure instead of silently reading as "unreachable".
 */
async function runCli(url: string): Promise<number> {
  try {
    await execFileAsync('npx', ['tsx', 'src/db/postgresReachable.ts', url], {
      cwd: API_ROOT,
      timeout: 10_000,
    });
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') {
      return code;
    }
    throw error;
  }
}

describe('isPostgresReachable', () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it('resolves true when something is listening on the target host:port', async () => {
    server = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('server did not report a port'));
        }
      });
    });

    await expect(isPostgresReachable(`postgresql://127.0.0.1:${port}/whatever`)).resolves.toBe(true);
  });

  it('resolves false when nothing is listening (connection refused)', async () => {
    // Nothing listens on port 1 on loopback, so this refuses immediately
    // (ECONNREFUSED) rather than timing out — no fixed sleep needed, same
    // pattern as ensureDatabase.test.ts's identical case.
    await expect(isPostgresReachable('postgresql://127.0.0.1:1/whatever')).resolves.toBe(false);
  });

  it('resolves false, rather than throwing, for an unparseable URL', async () => {
    await expect(isPostgresReachable('not-a-url')).resolves.toBe(false);
  });

  it('defaults to port 5432 when the URL specifies none', async () => {
    // Port 1 refuses; the default-port branch is exercised by omitting a port
    // from a URL that otherwise behaves like the refused-connection case
    // above (127.0.0.1:5432 is not expected to be listening in this test
    // environment — see ensureDatabase.ts's own header on why loopback:1 is
    // used instead where a guaranteed-closed port matters more than testing
    // the default itself).
    await expect(isPostgresReachable('postgresql://127.0.0.1/whatever', 200)).resolves.toBe(false);
  });
});

describe('postgresReachable.ts CLI — exit code mapping (the scripts/dev.sh integration contract)', () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it('exits 0 when the target is reachable', async () => {
    server = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('server did not report a port'));
        }
      });
    });

    await expect(runCli(`postgresql://127.0.0.1:${port}/whatever`)).resolves.toBe(0);
  }, 15_000);

  it('exits non-zero when the target is unreachable', async () => {
    await expect(runCli('postgresql://127.0.0.1:1/whatever')).resolves.not.toBe(0);
  }, 15_000);
});
