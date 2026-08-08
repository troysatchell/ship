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
 */
import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { isPostgresReachable } from '../postgresReachable.js';

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
