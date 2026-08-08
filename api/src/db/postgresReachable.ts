#!/usr/bin/env npx tsx
/**
 * Plain-TCP reachability check for a Postgres connection string.
 *
 * WHY THIS EXISTS (W4-R42 — one-command start bootstraps Postgres itself)
 *
 * `scripts/dev.sh` needs to decide, before calling `ensureDatabase.ts`,
 * whether Postgres is already up at the address it resolved — if not, and
 * `docker-compose.local.yml` is present, it brings the container up itself
 * instead of stopping with `ensureDatabase.ts`'s unreachable-database message
 * (see that file's `unreachableMessage()`, which stays the fallback for when
 * Docker isn't available; this module never replaces it, only sometimes
 * avoids reaching it).
 *
 * A plain TCP connect, not `pg_isready`/`psql`: this project's own factory
 * environment has neither on PATH
 * (`.claude/skills/ship-factory/references/lessons.md` #8), and `node`/`tsx`
 * are already a hard prerequisite of this whole script — same reasoning
 * `ensureDatabase.ts`'s own header gives for using a `pg` connection instead
 * of `createdb`.
 *
 * Deliberately does NOT attempt a real Postgres handshake (no `pg.Client`):
 * the caller only needs "is anything listening here", not "is this a valid
 * Postgres server, with valid credentials" — `ensureDatabase.ts` below still
 * does the real connection and reports the real error if the TCP-reachable
 * host isn't actually Postgres, or the credentials are wrong. Keeping this
 * check TCP-only also means it does not depend on `pg`'s connection-timeout
 * and retry behavior, which is tuned for a different job.
 */
import net from 'net';

export interface HostPort {
  host: string;
  port: number;
}

/**
 * Pure URL -> { host, port } resolution, with the same default-port rule
 * `isPostgresReachable` uses. Split out so the "a URL with no port defaults
 * to 5432" behavior can be asserted directly, on the parsed value, rather
 * than inferred from whether a socket connect happened to succeed —
 * `postgresReachable.test.ts` used to assert this by probing
 * `127.0.0.1:5432` and expecting a refusal, which is only true when nothing
 * else on the host happens to be listening there. It wasn't, in CI: GitHub
 * Actions runs a Postgres service on 5432, the probe correctly returned
 * `true`, and the test failed — not because the code was wrong, but because
 * the assertion depended on the environment instead of the behavior. Returns
 * `null` (rather than throwing) for an unparseable URL, same as the old
 * inline try/catch.
 */
export function resolveHostPort(databaseUrl: string): HostPort | null {
  try {
    const url = new URL(databaseUrl);
    // `url.port === ''` means the URL specified no port at all — default to
    // 5432. Deliberately NOT `Number(url.port) || 5432`: port 0 is a valid,
    // explicit port, and it is also falsy, so a `||` default would silently
    // rewrite an explicit `:0` to 5432 instead of honoring what the URL said.
    const port = url.port === '' ? 5432 : Number(url.port);
    // WHATWG `URL` keeps IPv6 host literals bracketed (`hostname` for
    // `postgresql://[::1]:5432/db` is the 5-character string `[::1]`, not
    // `::1`) — correct for a URL, but `net.createConnection`/`dns.lookup`
    // do not accept that bracketed form as a host. Observed directly:
    // `net.isIP('[::1]')` is `0` (not recognized as an IP at all) while
    // `net.isIP('::1')` is `6`, and connecting to a real IPv6 listener with
    // `{ host: '[::1]', port }` fails with `ENOTFOUND` while `{ host: '::1',
    // port }` connects — so every IPv6 DATABASE_URL previously read as
    // unreachable regardless of whether Postgres was actually listening.
    const hostname =
      url.hostname.startsWith('[') && url.hostname.endsWith(']')
        ? url.hostname.slice(1, -1)
        : url.hostname;
    return { host: hostname || 'localhost', port };
  } catch {
    return null;
  }
}

export function isPostgresReachable(databaseUrl: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    const resolved = resolveHostPort(databaseUrl);
    if (!resolved) {
      resolve(false);
      return;
    }

    const socket = net.createConnection({
      host: resolved.host,
      port: resolved.port,
      timeout: timeoutMs,
    });

    const finish = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };

    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.argv[2] ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Usage: postgresReachable.ts <databaseUrl>  (or set DATABASE_URL)');
    process.exit(2);
  }
  const reachable = await isPostgresReachable(databaseUrl);
  // Exit code only — scripts/dev.sh branches on this, not on stdout, so
  // startup output stays quiet in the common case (already reachable).
  process.exit(reachable ? 0 : 1);
}

// Only run when executed directly (`npx tsx postgresReachable.ts`), not when
// imported by the test file — same guard `ensureDatabase.ts` uses.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
