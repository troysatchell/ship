/**
 * Idempotent seed for Ship's own first-party OAuth app, `ship_app_fleetgraph`
 * (PF-701, PLUGFORGE.MD §4 "Seed first-party app" — TRO-423).
 *
 * This is the app the FleetGraph agent authenticates AS ITSELF via the
 * Client Credentials grant (PF-104, `issueClientCredentialsToken`) once
 * PF-702 flips `AGENT_PLATFORM_MODE` to `sdk` — its reads land in
 * `public_api_audit` under this app's `client_id`, not under any user
 * (docs/architecture.md "Agent as Platform Citizen"). Read-only scopes only
 * (`documents:read, issues:read, sprints:read`) — PF-700's human-checkpoint
 * scope defense is exactly "why the app needs only these three," and this
 * seed is where that defense becomes a structural guarantee: there is no
 * write/manage scope in `FLEETGRAPH_APP_SCOPES` for a future caller to widen
 * by accident.
 *
 * Structurally this closely follows PF-907's `seedGraderApp.ts` (same
 * hash-at-rest secret handling via `credentials.ts`, same
 * check-then-insert-with-ON-CONFLICT idempotency shape backed by the real
 * guarantee — `oauth_apps.client_id`'s unique index, migration 042) — but
 * two things differ deliberately, per the pre-implementation test design
 * (Linear TRO-423 comment, ship-test-designer, 2026-08-10):
 *
 * 1. **`client_id` is a fixed, well-known literal (`ship_app_fleetgraph`),
 *    not workspace-derived.** The grader app's client_id is workspace-scoped
 *    because nothing else in the codebase needs to know it ahead of time.
 *    FleetGraph's client_id is different: PF-702's agent code authenticates
 *    with `client_id` + `client_secret`, and PF-900's Terraform artifact
 *    (`terraform/render/variables.tf` — `fleetgraph_oauth_client_secret`,
 *    consumed by BOTH `web_service.tf` and `agent_service.tf`) only wires a
 *    *secret* env var, never a client_id one — confirmed by grep, no
 *    `FLEETGRAPH_OAUTH_CLIENT_ID` var exists anywhere in `terraform/`. The
 *    two sides can only agree on the same client_id if it's a fixed literal
 *    both independently know, matching how docs/architecture.md already
 *    refers to it by that exact literal name in prose, not as a derived
 *    value. This assumes single-tenancy for the deployed grading
 *    environment (one `ship_app_fleetgraph` app, globally) — the same
 *    assumption `db/seed.ts`'s own `workspaceId` lookup already makes
 *    ("Ship Workspace", singular).
 *
 * 2. **A missing secret THROWS, it does not silently skip.** The grader
 *    app's `seedGraderApp` returns `'skipped_no_secret'` because it is only
 *    ever invoked from `db/seed.ts` (a script an engineer runs locally,
 *    where the secret is normally absent by design). This function is
 *    ALSO invoked from `index.ts`'s boot path (the actual "boot check" half
 *    of this ticket's AC — every real process start in production, not just
 *    a manual `db:seed` run), and the test design's own AC-1 explicitly
 *    requires "with the env var unset, the boot-seed function throws/
 *    refuses rather than falling back to a hardcoded default secret." A
 *    thrown error is what makes a genuinely deployed environment (Terraform
 *    supplies `fleetgraph_oauth_client_secret` with NO default — see
 *    `terraform/render/variables.tf` — so its absence at runtime is *always*
 *    a misconfiguration, never an expected state) fail loudly instead of
 *    quietly running forever without the app the agent rewire depends on.
 *    Callers that must not throw for an ordinary unconfigured-secret case
 *    (local dev's `db/seed.ts`) are responsible for checking the env var
 *    themselves before calling this function — see `db/seed.ts`'s own call
 *    site for that guard, and `index.ts`'s boot-check call site for how the
 *    "deployed but genuinely misconfigured" case is handled without taking
 *    the whole process down (see that file's comment for the reasoning).
 *
 * `pool` is a constructor parameter rather than the `db/client.ts` singleton,
 * for the identical reason `seedGraderApp.ts` documents: `db/client.ts`
 * builds its pool at *module import* time from whatever `DATABASE_URL`
 * happens to be set then, which in production precedes `loadProductionSecrets()`
 * (SSM). `db/seed.ts` already builds its own `Pool` after secrets load and
 * passes it into its other helpers this same way.
 */

import type { Pool } from 'pg';
import { hashClientSecret } from './credentials.js';

/** Canonical env var name for the FleetGraph app's raw client secret (PM
 * triage, TRO-423 comment, 2026-08-10 — "the seed secret env var is
 * FLEETGRAPH_OAUTH_CLIENT_SECRET (canonical list on PF-900/TRO-411)").
 * Exported so callers — and this module's own test — never hardcode the
 * literal string and drift from what `terraform/render/variables.tf` and
 * `web_service.tf`/`agent_service.tf` actually commit to (already wired by
 * TRO-411/PF-900, verified present in both files before this ticket started
 * any code changes). */
export const FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR = 'FLEETGRAPH_OAUTH_CLIENT_SECRET';

/** Fixed, well-known client_id — see module header point 1 for why this is
 * a literal rather than workspace-derived. */
export const FLEETGRAPH_CLIENT_ID = 'ship_app_fleetgraph';

/** Human-readable display name for the seeded row. */
export const FLEETGRAPH_APP_NAME = 'FleetGraph Agent';

/** §2.3 / PF-700's scope-defense read-only scopes only — never a `:write` or
 * `webhooks:manage` scope. Exported (not inlined at the call site) so the
 * regression test asserts against the same array the seed actually uses,
 * rather than a second, hand-copied literal that could silently drift. */
export const FLEETGRAPH_APP_SCOPES = ['documents:read', 'issues:read', 'sprints:read'] as const;

export type SeedFirstPartyAppResult =
  | { status: 'created'; clientId: string }
  | { status: 'exists'; clientId: string };

/**
 * Idempotent: safe to call on every boot, every `db:seed` run, and every
 * restart. Two non-throwing outcomes:
 *
 * - No row for `client_id = ship_app_fleetgraph` yet → creates it, returns
 *   `'created'`.
 * - A row already exists → no-op, returns `'exists'`.
 *
 * Throws when `FLEETGRAPH_OAUTH_CLIENT_SECRET` is unset AND no row exists
 * yet — see module header point 2 for why this is a hard failure rather
 * than a skip, and for which callers are responsible for not reaching this
 * function at all in a context where an unset secret is expected and fine.
 */
export async function seedFirstPartyApp(pool: Pool, workspaceId: string): Promise<SeedFirstPartyAppResult> {
  // CodeRabbit (this PR review, Major): the secret MUST be read and
  // validated before the existing-row fast path below, not after — this is
  // deliberately not "only" a first-creation check. index.ts's boot check
  // calls this function on EVERY production boot, and the whole point of
  // "seeding guaranteed in deployed env (terraform env var + boot check)"
  // is a guarantee that holds on every boot, not just the first one. If the
  // secret were checked only on the not-found branch, a deployment that had
  // the app seeded once (secret present at the time) and then later had
  // FLEETGRAPH_OAUTH_CLIENT_SECRET removed from its env config (a real
  // misconfiguration — Terraform's var has no default, so removal only
  // happens out-of-band) would silently keep reporting 'exists' forever
  // and never surface the loud failure index.ts's boot check depends on.
  const rawSecret = process.env[FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR];
  if (!rawSecret) {
    throw new Error(
      `Cannot seed/verify the first-party ${FLEETGRAPH_CLIENT_ID} OAuth app: ` +
        `${FLEETGRAPH_OAUTH_CLIENT_SECRET_ENV_VAR} is not set. ` +
        'This must come from Terraform (terraform/render/variables.tf\'s ' +
        '`fleetgraph_oauth_client_secret`, no default) — never a hardcoded ' +
        'fallback secret.'
    );
  }

  // The unique index on oauth_apps.client_id (migration 042) is the actual
  // idempotency guarantee under a race — this SELECT is only a fast path,
  // same convention as seedGraderApp.ts's identical comment.
  const existing = await pool.query<{ client_id: string }>(
    `SELECT client_id FROM oauth_apps WHERE client_id = $1`,
    [FLEETGRAPH_CLIENT_ID]
  );
  const existingRow = existing.rows[0];
  if (existingRow) {
    return { status: 'exists', clientId: existingRow.client_id };
  }

  const secretHash = hashClientSecret(rawSecret);

  // CodeRabbit (this PR review, Minor): `RETURNING` distinguishes a real
  // insert from a conflict-resolved no-op under a race, rather than always
  // reporting 'created' regardless of which concurrent caller actually won.
  const insertResult = await pool.query<{ client_id: string }>(
    `INSERT INTO oauth_apps
       (workspace_id, name, client_id, client_type, client_secret_hash, requested_scopes, is_first_party)
     VALUES ($1, $2, $3, 'confidential', $4, $5, true)
     ON CONFLICT (client_id) DO NOTHING
     RETURNING client_id`,
    [workspaceId, FLEETGRAPH_APP_NAME, FLEETGRAPH_CLIENT_ID, secretHash, [...FLEETGRAPH_APP_SCOPES]]
  );

  return insertResult.rows[0]
    ? { status: 'created', clientId: FLEETGRAPH_CLIENT_ID }
    : { status: 'exists', clientId: FLEETGRAPH_CLIENT_ID };
}
