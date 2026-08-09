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
 *
 * One case in block 1 binds a real `net.Server` on the IPv6 loopback
 * address (`::1`) end-to-end. That's an environment assumption a host with
 * IPv6 loopback disabled won't satisfy, so it's gated behind a real
 * capability probe (`ipv6LoopbackAvailable()`) and registered as `it.skip`
 * — not silently absorbed — when the bind isn't possible; see that
 * function's doc comment. The pure `resolveHostPort` IPv6 bracket-stripping
 * assertions in block 2 never touch a socket and always run: those are the
 * actual guarantee against the bracket-stripping regression, not the
 * end-to-end case.
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
 * Same narrowing shape as `isErrorWithNumericCode`, but for Node's
 * errno-style `code` (a string like `'EADDRNOTAVAIL'`, e.g. on a
 * `net.Server`'s `'error'` event) rather than a numeric exit code.
 */
function isErrorWithStringCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as Record<'code', unknown>).code === 'string'
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

/**
 * True when this host can actually bind a TCP listener on the IPv6 loopback
 * address (`::1`). Answered by attempting the real bind, not by inspecting
 * `os.networkInterfaces()` or similar — the test below is about to do the
 * same bind, so the probe needs to observe the same failure mode it would.
 *
 * Only the two error codes that specifically mean "IPv6 loopback isn't
 * available on this host" are treated as "unavailable" and swallowed:
 * `EADDRNOTAVAIL` (loopback interface has no ::1 address configured) and
 * `EAFNOSUPPORT` (the address family isn't supported at all). Anything else
 * rethrows — an unexpected bind failure should fail the test loudly, not be
 * silently absorbed into "must be an environment thing".
 */
async function ipv6LoopbackAvailable(): Promise<boolean> {
  const probe = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '::1', () => resolve());
    });
    return true;
  } catch (error) {
    if (isErrorWithStringCode(error) && (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')) {
      return false;
    }
    throw error;
  } finally {
    // Fire-and-forget: if the bind failed, the server never held an open
    // handle and close() is a harmless no-op; if it succeeded, this frees
    // the ephemeral port immediately rather than waiting on the caller.
    probe.close();
  }
}

// Decided once at module load (top-level await — this file is ESM), so the
// probe result is available before `describe`/`it` register their tests,
// and so the same decision is used consistently by every test in the file
// rather than re-probed per test.
const IPV6_LOOPBACK_AVAILABLE = await ipv6LoopbackAvailable();
if (!IPV6_LOOPBACK_AVAILABLE) {
  // Loud, not silent: printed unconditionally so a skip is visible in test
  // output rather than looking identical to "ran and passed". The pure
  // resolveHostPort IPv6 bracket-stripping assertions below still run
  // unconditionally regardless of this — they need no socket at all, and
  // they're where the actual bracket-stripping regression would surface.
  console.warn(
    '[postgresReachable.test.ts] SKIPPING "resolves true against an IPv6 listener" — ' +
      'IPv6 loopback (::1) is not bindable on this host (EADDRNOTAVAIL/EAFNOSUPPORT). ' +
      'The unconditional resolveHostPort IPv6 parsing tests still cover the bracket-' +
      'stripping regression this end-to-end case exists to double-check.'
  );
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

  // Registered as a real `it` only when this host can actually bind ::1
  // (see ipv6LoopbackAvailable() above and its console.warn when it can't).
  // `it.skip` marks the case as skipped in the test report — visibly absent,
  // not a silent pass — rather than the test body running and doing nothing
  // on a host without IPv6 loopback. The unconditional resolveHostPort IPv6
  // cases in the next describe block are the ones that must never be
  // allowed to skip: this one is corroborating end-to-end evidence on top
  // of them, not the only place the regression could be caught.
  (IPV6_LOOPBACK_AVAILABLE ? it : it.skip)('resolves true against an IPv6 listener addressed via a bracketed URL', async () => {
    // End-to-end version of the resolveHostPort bracket-stripping regression
    // below: a real listener on ::1, reached through the bracketed URL form
    // Postgres connection strings actually use. Before the fix this always
    // resolved false (ENOTFOUND on the literal string '[::1]'), regardless
    // of whether anything was listening.
    server = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server?.listen(0, '::1', () => {
        const address = server?.address();
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('server did not report a port'));
        }
      });
    });

    await expect(isPostgresReachable(`postgresql://[::1]:${port}/whatever`)).resolves.toBe(true);
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

  it('strips the brackets from an IPv6 host literal', () => {
    // `new URL('postgresql://[::1]:5432/whatever').hostname` is the string
    // `'[::1]'`, brackets included — valid for a URL, but net.createConnection
    // treats '[::1]' as an ordinary (unresolvable) hostname, not the IPv6
    // address ::1, and fails with ENOTFOUND against it. Host must come
    // through unbracketed.
    expect(resolveHostPort('postgresql://[::1]:5432/whatever')).toEqual({ host: '::1', port: 5432 });
  });

  it('strips the brackets from a full IPv6 host literal', () => {
    expect(resolveHostPort('postgresql://[2001:db8::1]:5432/whatever')).toEqual({
      host: '2001:db8::1',
      port: 5432,
    });
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
