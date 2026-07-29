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
 */
export function resolveDatabaseSsl(
  nodeEnv: string | undefined = process.env.NODE_ENV
): DatabaseSslConfig {
  return nodeEnv === 'production' ? { rejectUnauthorized: false } : false;
}
