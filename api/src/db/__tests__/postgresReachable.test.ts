/**
 * Regression tests for `postgresReachable.ts` (W4-R42 — `scripts/dev.sh`
 * bootstraps Postgres via Docker when it's unreachable at the default
 * address, instead of stopping at `ensureDatabase.ts`'s unreachable-database
 * message).
 *
 * Three `describe` blocks:
 *
 * 1. `isPostgresReachable` — the real TCP check against a real, throwaway
 *    `net.Server` (the "reachable" case) and a real, guaranteed-closed port
 *    (the "unreachable" case) — no mocked sockets, so a change to the
 *    timeout/error-handling wiring would actually be caught here.
 * 2. `resolveHostPort` — the pure URL -> { host, port } parsing
 *    `isPostgresReachable` uses internally, asserted directly rather than
 *    through a socket probe. Kept separate on purpose: a version of this
 *    suite once asserted "defaults to 5432" by connecting to 127.0.0.1:5432
 *    and expecting a refusal, which only holds when nothing else on the host
 *    happens to be listening there — it wasn't, in CI (GitHub Actions runs a
 *    Postgres service on 5432), so a correct probe result failed the test.
 *    Every case here is deterministic regardless of what is or isn't
 *    listening anywhere.
 * 3. The CLI (`npx tsx src/db/postgresReachable.ts <url>`) as a subprocess,
 *    asserting on its real exit code — the exact contract `scripts/dev.sh`
 *    depends on (`if (... && npx tsx src/db/postgresReachable.ts "$URL");
 *    then ...`, branching on `$?`). Without this, an inverted
 *    `process.exit(reachable ? 0 : 1)` in `main()` would leave every test
 *    above green while the real integration silently broke.
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { isPostgresReachable, resolveHostPort } from '../postgresReachable.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
// api/src/db/__tests__ -> api (three levels up), matching the cwd
// scripts/dev.sh actually runs the CLI from: `(cd "$ROOT_DIR/api" && npx tsx
// src/db/postgresReachable.ts "$RESOLVED_DATABASE_URL")`.
const API_ROOT = join(__dirname, '..', '..', '..');

/**
 * True when `error` is a non-null object carrying a numeric `code` —
 * narrowed explicitly rather than asserted, since the catch variable is
 * `unknown` and execFile's rejection value is read off it without any
 * runtime guarantee of shape. Reading `.code` off an unnarrowed `unknown`
 * (e.g. via `as { code?: unknown }`) would throw its own TypeError if
 * `error` ever turned out to be `null`/a primitive, masking the original
 * failure instead of rethrowing it.
 */
function isErrorWithNumericCode(error: unknown): error is { code: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as Record<'code', unknown>).code === 'number'
  );
}

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
    if (isErrorWithNumericCode(error)) {
      return error.code;
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
});

describe('resolveHostPort', () => {
  // Pure parsing, no socket involved — deliberately not asserted via a probe.
  // A prior version of this suite tested "defaults to 5432" by connecting to
  // 127.0.0.1:5432 and asserting the connection was refused, which is only
  // true when nothing else on the host happens to be listening there. It
  // wasn't, in CI: GitHub Actions runs a Postgres service on 5432, the probe
  // correctly returned reachable, and the test failed — not because the code
  // was wrong, but because the assertion depended on the environment instead
  // of the behavior. Asserting directly on the parsed { host, port } has no
  // such dependency: it is true or false the same way on every machine.
  it('defaults to port 5432 when the URL specifies none', () => {
    expect(resolveHostPort('postgresql://127.0.0.1/whatever')).toEqual({ host: '127.0.0.1', port: 5432 });
  });

  it('uses the explicit port when the URL specifies one', () => {
    expect(resolveHostPort('postgresql://127.0.0.1:5433/whatever')).toEqual({ host: '127.0.0.1', port: 5433 });
  });

  it('preserves an explicit port 0 rather than defaulting it to 5432', () => {
    // Number('0') is 0, and 0 is falsy — a `Number(url.port) || 5432` default
    // would silently rewrite this explicit port to 5432. Port must come
    // through as the number 0, unchanged.
    expect(resolveHostPort('postgresql://127.0.0.1:0/whatever')).toEqual({ host: '127.0.0.1', port: 0 });
  });

  it('returns null, rather than throwing, for an unparseable URL', () => {
    expect(resolveHostPort('not-a-url')).toBeNull();
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
