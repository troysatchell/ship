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

export function isPostgresReachable(databaseUrl: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    let url: URL;
    try {
      url = new URL(databaseUrl);
    } catch {
      resolve(false);
      return;
    }

    const socket = net.createConnection({
      host: url.hostname || 'localhost',
      port: Number(url.port) || 5432,
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
