/**
 * The single SSL decision for every pool that connects to Ship's own database.
 *
 * WHY THIS FILE EXISTS
 *
 * There used to be one copy of this ternary in `migrate.ts`, one in `seed.ts`,
 * and none at all in `client.ts` — the pool the running application uses. The
 * drift was the defect, not any one of the three values: `client.ts` passed no
 * `ssl` key, so pg fell back to `defaults.ssl = false` and connected in
 * plaintext, while the two scripts that run *around* it negotiated TLS.
 *
 * That produced a deeply misleading failure signature. `Dockerfile:35` is
 * `node dist/db/migrate.js && node dist/index.js`: migrate configured SSL,
 * connected, exited 0, and the `&&` proceeded — then the app pool failed to
 * connect. The logs read "migration succeeded, database unreachable", which
 * looks like a database problem rather than a client-config one, and
 * `connectionTimeoutMillis: 2000` turned it into a fast crash-loop instead of a
 * legible TLS error.
 *
 * On AWS it never surfaced: Aurora is in-VPC, the connection is internal, and
 * an unconfigured `ssl` works. The gap only appears against a managed Postgres
 * that requires TLS on a public endpoint — i.e. every PaaS, including Render.
 *
 * Import this from every pool site instead of re-deriving the rule, so the
 * files cannot drift apart again.
 *
 * PRECEDENCE — THIS HELPER IS NOT THE LAST WORD
 *
 * There is a third input besides this file and the pool configs: the connection
 * string. `DATABASE_URL=...?sslmode=disable` **beats** whatever is returned here.
 * pg does `config = Object.assign({}, config, parse(config.connectionString))`
 * (`pg/lib/connection-parameters.js:56`, whose own comment on :54 says "this will
 * override other default values with what is stored in connectionString"), so the
 * parsed URL is the last source and its `ssl` key overwrites the caller's;
 * `pg-connection-string/index.js:76` sets `ssl = {}` whenever `sslmode` is present
 * and `:133-135` sets `ssl = false` for `disable`. Then
 * `connection-parameters.js:81` uses that value as-is.
 *
 * Effective order, weakest to strongest: pg defaults → `PGSSLMODE` → the `ssl`
 * option this helper returns → `sslmode` in the connection string.
 *
 * That matters because these strings arrive by being copied from a provider
 * dashboard. A stray `sslmode=disable` would put production back on plaintext
 * while this helper reported the right value and every test here passed. Since
 * the option cannot win, `resolveDatabaseSsl` refuses to start instead — see the
 * throw below. Do not "fix" that by rewriting the URL: silently editing an
 * operator's explicit instruction is how the original bug stayed invisible.
 *
 * ON `rejectUnauthorized: false`
 *
 * This preserves exactly what `migrate.ts` and `seed.ts` already did: encrypt
 * the connection, but do not verify the server certificate chain. Managed
 * Postgres providers front their instances with certificates signed by their own
 * CA, which is not in Node's trust store, so chain verification fails without
 * the provider CA bundle supplied out of band.
 *
 * That is a deliberate carry-over, not an endorsement. It stops passive
 * eavesdropping but not an active man-in-the-middle. A federal deployment
 * probably wants `rejectUnauthorized: true` plus an explicit `ca`. Doing that
 * here would be a silent posture change that no test in this repo can verify,
 * so it is left as a follow-up that needs the CA bundle decided first.
 */
import type { ClientConfig } from 'pg';

/** The `ssl` field of a pg pool/client config. */
export type DatabaseSslConfig = ClientConfig['ssl'];

/**
 * `sslmode` values that resolve to an UNENCRYPTED connection in pg.
 *
 * Verified empirically against pg 8.16.3 / pg-connection-string 2.9.1 by reading
 * `connectionParameters.ssl` for every documented value while passing an explicit
 * `{ rejectUnauthorized: false }`. Only `disable` yields plaintext:
 *
 *   (no sslmode)  -> { rejectUnauthorized: false }   encrypted (our option survives)
 *   disable       -> false                            PLAINTEXT
 *   prefer        -> {}                               encrypted
 *   require       -> {}                               encrypted
 *   verify-full   -> {}                               encrypted
 *   no-verify     -> { rejectUnauthorized: false }    encrypted
 *
 * Note `prefer` does NOT mean libpq's "try TLS, fall back to plaintext" here —
 * pg-connection-string:132-142 leaves `config.ssl = {}` for it, so pg encrypts.
 */
const PLAINTEXT_SSL_MODES: ReadonlySet<string> = new Set(['disable']);

/** The `sslmode` query parameter of a connection string, lowercased. */
function sslModeOf(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null;
  try {
    return new URL(databaseUrl).searchParams.get('sslmode')?.toLowerCase() ?? null;
  } catch {
    // Not a parseable URL. Not this function's problem to report — pg will.
    return null;
  }
}

/**
 * Resolve the `ssl` option for a pool connecting to Ship's database.
 *
 * @param nodeEnv - Environment to decide against. Defaults to
 *   `process.env.NODE_ENV`, read at call time. Pass it explicitly only in tests;
 *   production code should call this with no arguments.
 * @returns `{ rejectUnauthorized: false }` in production (encrypt, skip chain
 *   verification), `false` everywhere else (local Postgres and CI containers
 *   speak plaintext and would reject a TLS handshake).
 *
 * A fresh object is returned on every call so no two pools can share — and
 * mutate — one TLS config.
 *
 * @param databaseUrl - Connection string to check for an SSL-weakening `sslmode`
 *   parameter. Defaults to `process.env.DATABASE_URL`, read at call time.
 * @throws If `nodeEnv` is production and `databaseUrl` carries an `sslmode` that
 *   pg resolves to a plaintext connection. See the note below — the returned
 *   value is NOT the last word, so refusing to start is the only way to keep the
 *   production guarantee.
 */
export function resolveDatabaseSsl(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  databaseUrl: string | undefined = process.env.DATABASE_URL
): DatabaseSslConfig {
  if (nodeEnv !== 'production') {
    // Outside production a plaintext-forcing sslmode is legitimate: local
    // Postgres and the CI container speak plaintext and would refuse a handshake.
    return false;
  }

  const sslMode = sslModeOf(databaseUrl);
  if (sslMode !== null && PLAINTEXT_SSL_MODES.has(sslMode)) {
    throw new Error(
      `Refusing to start: DATABASE_URL sets sslmode=${sslMode}, which pg resolves to an ` +
        `UNENCRYPTED connection, and the connection string OVERRIDES the ssl option this ` +
        `application passes — pg applies the parsed connection string last ` +
        `(pg/lib/connection-parameters.js:56), so it wins. Production database traffic would ` +
        `be sent in the clear while this code reported TLS. Remove the sslmode parameter from ` +
        `DATABASE_URL; the application selects TLS itself in production (api/src/db/ssl.ts). ` +
        `If plaintext is genuinely intended for this deployment, that is a decision to make ` +
        `explicitly, not by way of a copied connection string.`
    );
  }

  return { rejectUnauthorized: false };
}
