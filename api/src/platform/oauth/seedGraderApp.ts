/**
 * Idempotent seed for the grader's read-only OAuth app (PF-907, PLUGFORGE.MD
 * §4 "Grader access" / §9 E9 — TRO-441).
 *
 * Models PF-701's "seed first-party app" pattern (`ship_app_fleetgraph`:
 * idempotent boot/migration seed, `is_first_party`, read-only scopes, secret
 * via env, never committed) — PF-701 itself has not landed on this branch
 * (no `ship_app_fleetgraph` reference exists in this worktree as of
 * 2026-08-11), so this module does not call into it; it independently
 * follows the same shape for the grader's own app, reusing PF-102's
 * credential primitives (`credentials.ts`) rather than PF-102's
 * `createOAuthApp` directly, because that function always mints a fresh
 * random secret — the grader app's secret must be the one already
 * provisioned via `GRADER_OAUTH_CLIENT_SECRET` (PM triage, TRO-441 comments,
 * 2026-08-10: "same shared-config rule as PF-900/TRO-411"), not a new one
 * generated per seed run — a fresh secret every deploy would break whatever
 * out-of-band place records "the" grader credential.
 *
 * `pool` is a constructor parameter, not the shared singleton imported from
 * `db/client.ts`, deliberately: `db/client.ts` builds its pool at *module
 * import* time from whatever `DATABASE_URL` happens to be in `process.env`
 * then, which in production runs before `seed.ts`'s own
 * `loadProductionSecrets()` (SSM) call populates it. `db/seed.ts` already
 * builds its own `Pool` explicitly after secrets load and passes it into its
 * other helpers this same way (see `createAssociation(pool, ...)`) — this
 * module follows that existing convention rather than introducing a second,
 * differently-sequenced connection.
 */

import type { Pool } from 'pg';
import { generateClientId, hashClientSecret } from './credentials.js';

/** Canonical env var name for the grader app's raw client secret (PM triage,
 * TRO-441 comments, 2026-08-10). Exported so callers — and this module's own
 * test — never hardcode the string literal and drift from whatever name
 * PF-900's Terraform artifact actually commits to. */
export const GRADER_OAUTH_CLIENT_SECRET_ENV_VAR = 'GRADER_OAUTH_CLIENT_SECRET';

/** Stable display name used to find "the" grader app on re-seed (no unique
 * DB constraint backs this — same check-then-insert idempotency shape every
 * other fixture in `db/seed.ts` already uses, scoped by workspace). */
export const GRADER_APP_NAME = 'Grader (read-only)';

/** §2.3 read-only scopes only — never `webhooks:manage` or any `:write`
 * scope. A grader account must not be able to mutate graded state (PF-700's
 * checkpoint states the identical constraint for the FleetGraph app). */
export const GRADER_APP_SCOPES = ['documents:read', 'issues:read', 'sprints:read'] as const;

export type SeedGraderAppResult =
  | { status: 'created'; clientId: string }
  | { status: 'exists'; clientId: string }
  | { status: 'skipped_no_secret' };

/**
 * Idempotent: safe to call on every `db:seed` run (local dev, CI, deployed
 * boot). Three outcomes, none of them an error:
 *
 * - No row for this workspace yet, secret configured → creates it, returns
 *   `'created'`.
 * - A row already exists (checked by `name` + `workspace_id`, the same
 *   check-then-insert idempotency shape every other `db/seed.ts` fixture
 *   uses — there is no unique DB constraint on `name`) → no-op, returns
 *   `'exists'` with the existing `client_id`.
 * - No row yet AND `GRADER_OAUTH_CLIENT_SECRET_ENV_VAR` is unset → skips
 *   without throwing, returns `'skipped_no_secret'`. This is the case for
 *   every ordinary local `pnpm db:seed` / `./start.sh` run, which must keep
 *   working unchanged without that var — the grader app is only meant to
 *   exist where the secret has actually been provisioned (a deployed grader
 *   environment, per PF-900's Terraform artifact).
 */
export async function seedGraderApp(pool: Pool, workspaceId: string): Promise<SeedGraderAppResult> {
  const existing = await pool.query<{ client_id: string }>(
    `SELECT client_id FROM oauth_apps WHERE workspace_id = $1 AND name = $2 AND is_first_party = true`,
    [workspaceId, GRADER_APP_NAME]
  );
  const existingRow = existing.rows[0];
  if (existingRow) {
    return { status: 'exists', clientId: existingRow.client_id };
  }

  const rawSecret = process.env[GRADER_OAUTH_CLIENT_SECRET_ENV_VAR];
  if (!rawSecret) {
    return { status: 'skipped_no_secret' };
  }

  const clientId = generateClientId();
  const secretHash = hashClientSecret(rawSecret);

  await pool.query(
    `INSERT INTO oauth_apps
       (workspace_id, name, client_id, client_type, client_secret_hash, requested_scopes, is_first_party)
     VALUES ($1, $2, $3, 'confidential', $4, $5, true)`,
    [workspaceId, GRADER_APP_NAME, clientId, secretHash, [...GRADER_APP_SCOPES]]
  );

  return { status: 'created', clientId };
}
