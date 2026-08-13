/**
 * Resolves the workspace a `/api/v1` request is scoped to, from the
 * authenticated `req.principal` (PF-107, `platform/oauth/bearerAuth.ts` +
 * `principal.ts`).
 *
 * GAP, flagged plainly (PF-200/TRO-398 final report — read before reusing
 * this for a later resource ticket, PF-201/PF-205): `Principal` carries no
 * `workspaceId`, even though both underlying credential rows have exactly
 * one — `oauth_apps.workspace_id`, `api_tokens.workspace_id`. Every
 * `documents` row is `workspace_id NOT NULL`, so a v1 resource route cannot
 * scope (or safely write) without resolving one from somewhere.
 *
 * Extending `Principal` with `workspaceId` would be the structurally clean
 * fix, but it changes PF-107's already-merged, already-tested output shape:
 * `bearerAuth.test.ts`'s `AC-1` cases assert `req.principal` with a strict
 * `toEqual`, which would need updating for every case. That is an
 * auth-semantics change to a file outside this ticket's scope
 * (`ship-backend`'s "changes to session semantics ... escalate before
 * merge" rule), so this module is the documented workaround: a second,
 * read-only lookup that does not touch PF-107's files.
 *
 *  - **App-token principal** (`principal.app` set): `oauth_apps.workspace_id`
 *    for `principal.app.id` — exact and unambiguous. An OAuth app belongs to
 *    exactly one workspace (§2.2), the same fact `appRegistration.ts`
 *    already relies on.
 *  - **Personal-token principal** (`principal.app` null, `principal.user`
 *    set): `users.last_workspace_id` — the same column `routes/auth.ts:110`
 *    and `routes/caia-auth.ts:256` already treat as "the workspace this user
 *    is currently in". This is a DERIVED approximation, not exact: a user
 *    who belongs to more than one workspace and minted their personal token
 *    while active in a workspace other than their current
 *    `last_workspace_id` would be scoped to the wrong one here.
 *    `api_tokens.workspace_id` — the token's own, exact workspace — is not
 *    visible from `Principal` for the same reason described above. Recorded
 *    as a follow-up: extend `Principal` with `workspaceId` once an owner can
 *    update PF-107's tests to match.
 *
 * Returns `null` when no workspace can be resolved at all (e.g. a personal
 * token for a user who has never joined a workspace, or a dangling
 * `app_id`). Callers MUST treat `null` as "resolve to nothing" — an empty
 * list, a 404, a 403 — never as "every workspace unscoped."
 */

import { pool } from '../../../../db/client.js';
import type { Principal } from '../../../oauth/principal.js';

interface OauthAppWorkspaceRow {
  workspace_id: string;
}

interface UserLastWorkspaceRow {
  last_workspace_id: string | null;
}

export async function resolvePrincipalWorkspaceId(principal: Principal): Promise<string | null> {
  if (principal.app) {
    const result = await pool.query<OauthAppWorkspaceRow>(
      `SELECT workspace_id FROM oauth_apps WHERE id = $1`,
      [principal.app.id]
    );
    return result.rows[0]?.workspace_id ?? null;
  }

  if (principal.user) {
    const result = await pool.query<UserLastWorkspaceRow>(
      `SELECT last_workspace_id FROM users WHERE id = $1`,
      [principal.user.id]
    );
    return result.rows[0]?.last_workspace_id ?? null;
  }

  return null;
}
