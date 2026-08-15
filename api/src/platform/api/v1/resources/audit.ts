/**
 * `/api/v1/audit` — PF-501 (Linear TRO-432, PLUGFORGE.MD §2.7/§4).
 *
 * `GET /` lists `public_api_audit` rows (written by
 * `platform/audit/middleware.ts`'s fire-and-forget INSERT on every `/api/v1`
 * call), cursor-paginated, newest first — mirrors `resources/webhooks.ts`'s
 * `GET /` list-route shape exactly (same query schema fields, same
 * `{ data, next_cursor }` envelope, same keyset-cursor helpers).
 *
 * **This is E7's proof surface** (architect note, this ticket's brief): a
 * later ticket (PF-704) greps this table for a specific agent's `client_id`
 * to prove every agent action went through `/api/v1`. `app_client_id` is
 * therefore a plain queryable TEXT column (migration 049), never buried in a
 * JSON blob, and this route's `?app_client_id=` filter is the AC's literal
 * "queryable per app."
 *
 * **Authorization — "admin/owner-scoped" (PRD, §4 PF-501), a binding design
 * decision made by this ticket, not specified further by the PRD.** Holding
 * the `audit:read` scope is necessary but not sufficient: `api-tokens.ts`
 * lets ANY user self-mint a personal token requesting any scope
 * `ScopeRegistry` knows about (no admin check at mint time), so a scope
 * alone cannot express "admin/owner only" — something that actually reads
 * the caller's role has to gate this route. This schema has no distinct
 * `owner` role (`workspace_memberships.role` is `CHECK (role IN ('admin',
 * 'member'))` — schema.sql:40), so this ticket maps the PRD's two words onto
 * the two elevated-access concepts that already exist in this codebase:
 *
 *   - **"owner"** -> `users.is_super_admin` (schema.sql:21) — the existing
 *     platform-wide elevated role `routes/admin.ts`/`middleware/auth.ts`
 *     already use for cross-workspace internal-admin actions. A super-admin
 *     sees every workspace's audit rows, unscoped — the platform owner, not
 *     an owner of any one workspace.
 *   - **"admin"** -> `workspace_memberships.role = 'admin'` for the
 *     caller's own resolved workspace (`resolveWorkspaceOrThrow`, same
 *     helper `resources/webhooks.ts` uses) — scoped to exactly that
 *     workspace's rows.
 *   - A **Client Credentials principal with no acting user** (no human to
 *     check a role against) is trusted at the "admin" tier ONLY when
 *     `principal.app.isFirstParty` is true, scoped to that app's own
 *     workspace — a third-party app can never read the audit trail
 *     regardless of which scopes its token was granted (see the `GET /`
 *     test file's "first-party required" case: `audit:read` present is not
 *     enough on its own).
 *   - An authorization_code principal (both `app` and `user` set) is
 *     evaluated on `principal.user`'s role, the same as a plain personal
 *     token — consistent with PF-703's "the human's write token ...
 *     attribute to the human user" precedent: when a human is present,
 *     their permissions govern, not the app's.
 *
 * **Workspace scoping of the row set itself.** A non-owner caller's rows are
 * filtered to: (a) every row whose `app_client_id` belongs to an
 * `oauth_apps` row in the caller's workspace, OR (b) every row with a NULL
 * `app_client_id` (a personal-token call) whose `user_id` is a member of the
 * caller's workspace. Without this, any workspace admin could read every
 * OTHER workspace's audit trail — a real tenant-isolation gap the PRD's one
 * line doesn't spell out but that "admin-scoped" cannot sensibly mean
 * without it. `owner` (super-admin) access has no such filter — see above.
 */

import { Router } from 'express';
import type { Request, Router as RouterType } from 'express';
import { z } from 'zod';
import { pool } from '../../../../db/client.js';
import { bearerAuth } from '../../../oauth/bearerAuth.js';
import type { Principal } from '../../../oauth/principal.js';
import { requireScope } from '../../../scopes/requireScope.js';
import { rateLimitBuckets } from '../../../ratelimit/middleware.js';
import { asyncHandler } from '../errorMiddleware.js';
import { forbiddenError, serverError, validationFailedError } from '../errors.js';
import { encodeCursor, decodeCursor, preciseTimestamp, type KeysetCursor } from '../pagination.js';
import { resolvePrincipalWorkspaceId } from './workspaceContext.js';

export const auditRouter: RouterType = Router();

/** Same defensive fallback pattern as every other v1 resource file's own
 * `requestIdOf` — every request reaching an `auditRouter` handler already
 * ran `requestIdMiddleware` (mounted first on `v1Router`). */
function requestIdOf(req: Request): string {
  return req.requestId ?? 'missing-request-id';
}

/** `GET /api/v1/audit` query params — same cursor-pagination shape as
 * `resources/webhooks.ts`'s `ListWebhookSubscriptionsQuerySchema`, plus the
 * `app_client_id` filter this ticket's own AC ("queryable per app") calls
 * for. */
export const ListAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().min(1).optional(),
  app_client_id: z.string().min(1).optional(),
});

/** Row shape for `public_api_audit` (migration 049), exactly the §2.7 column
 * list, plus `created_at_precise` (see `AUDIT_COLUMNS`'s comment). */
interface AuditRow {
  id: string;
  request_id: string;
  app_client_id: string | null;
  user_id: string | null;
  method: string;
  route: string;
  scope_used: string | null;
  status: number;
  latency_ms: number;
  created_at: Date;
  /** `created_at::text` — cursor-internal only, never serialized into a
   *  response. See its own comment on `AUDIT_COLUMNS` for why this exists. */
  created_at_precise: string;
}

/**
 * `created_at::text AS created_at_precise` (CodeRabbit, this PR's review —
 * the same precision-loss defect this ticket's own CHANGES.md entry and
 * pagination test already disclosed as a SHARED bug in
 * `platform/api/v1/pagination.ts`, out of scope to fix there): `pg`'s
 * default type parser converts a `timestamptz` column into a JS `Date`,
 * which is MILLISECOND precision, while Postgres itself retains
 * microseconds. Building a cursor from `row.created_at.toISOString()`
 * therefore loses precision at the moment the row is READ, before any
 * cursor code runs — two rows in the same millisecond can then put a
 * not-yet-fetched row on the wrong side of a truncated cursor boundary and
 * drop it from pagination silently and permanently (reproduced directly —
 * see this PR's own pagination test comment and CHANGES.md entry).
 *
 * `::text` on a `timestamptz` column is cast SERVER-SIDE, before the value
 * ever reaches `pg`'s type parser — the wire type becomes `text`, which
 * `pg` returns verbatim (no Date conversion, no precision loss). That text
 * is Postgres's own canonical `timestamptz` output format, which Postgres
 * parses back losslessly when it's later bound as a query parameter in the
 * cursor's `WHERE (created_at, id) < ($1, $2)` comparison — so THIS route's
 * own pagination is fixed without touching pagination.ts or any other
 * `/api/v1` list route. `documents`/`issues`/`sprints`/`webhooks` still
 * carry the shared bug; that fix is filed separately (see CHANGES.md).
 *
 * Response shape is UNCHANGED: `serializeAuditRow` never reads
 * `created_at_precise`, only `created_at` (the ordinary Date, millisecond
 * ISO string) — this column exists purely to build a correct cursor.
 */
const AUDIT_COLUMNS =
  'id, request_id, app_client_id, user_id, method, route, scope_used, status, latency_ms, created_at, ' +
  'created_at::text AS created_at_precise';

function serializeAuditRow(row: AuditRow) {
  return {
    id: row.id,
    request_id: row.request_id,
    app_client_id: row.app_client_id,
    user_id: row.user_id,
    method: row.method,
    route: row.route,
    scope_used: row.scope_used,
    status: row.status,
    latency_ms: row.latency_ms,
    created_at: row.created_at.toISOString(),
  };
}

/** What `resolveAuditAccess` grants: either unscoped ("owner"/super-admin)
 *  visibility, or visibility scoped to exactly one workspace ("admin" —
 *  a workspace_memberships.role='admin' human, or a first-party app). */
interface AuditAccess {
  owner: boolean;
  workspaceId: string | null;
}

/** See this file's header for the full "admin/owner-scoped" design
 *  rationale. Returns `null` when the caller is authenticated and holds
 *  `audit:read` but is neither a super-admin, a workspace admin, nor a
 *  first-party app — i.e. the scope alone was not enough. */
async function resolveAuditAccess(principal: Principal): Promise<AuditAccess | null> {
  if (principal.user) {
    const superAdminResult = await pool.query<{ is_super_admin: boolean }>(
      `SELECT is_super_admin FROM users WHERE id = $1`,
      [principal.user.id]
    );
    if (superAdminResult.rows[0]?.is_super_admin === true) {
      return { owner: true, workspaceId: null };
    }

    const workspaceId = await resolvePrincipalWorkspaceId(principal);
    if (!workspaceId) {
      return null;
    }

    const membershipResult = await pool.query<{ role: string }>(
      `SELECT role FROM workspace_memberships WHERE user_id = $1 AND workspace_id = $2`,
      [principal.user.id, workspaceId]
    );
    if (membershipResult.rows[0]?.role === 'admin') {
      return { owner: false, workspaceId };
    }
    return null;
  }

  // No acting user: a Client Credentials principal. Only a first-party app
  // is trusted at the "admin" tier — see file header.
  if (principal.app?.isFirstParty) {
    const workspaceId = await resolvePrincipalWorkspaceId(principal);
    if (!workspaceId) {
      return null;
    }
    return { owner: false, workspaceId };
  }

  return null;
}

// ─── GET /api/v1/audit ───────────────────────────────────────────────────

auditRouter.get(
  '/',
  bearerAuth,
  rateLimitBuckets,
  requireScope('audit:read'),
  asyncHandler(async (req, res) => {
    const requestId = requestIdOf(req);
    const principal = req.principal;
    if (!principal) {
      // Unreachable in practice — bearerAuth never calls next() without
      // setting req.principal — but TypeScript can't see that guarantee
      // statically (req.principal is typed optional). Same defensive
      // pattern (and same serverError, not forbiddenError — this is an
      // internal-state inconsistency, not a caller authorization failure)
      // as resources/webhooks.ts and resources/me.ts use for the identical
      // check.
      throw serverError(requestId);
    }

    const parseResult = ListAuditQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      throw validationFailedError(requestId, 'Invalid query parameters.', {
        fieldErrors: parseResult.error.flatten().fieldErrors,
      });
    }
    const { limit, cursor, app_client_id: appClientIdFilter } = parseResult.data;

    let decodedCursor: KeysetCursor | null = null;
    if (cursor !== undefined) {
      decodedCursor = decodeCursor(cursor);
      if (!decodedCursor) {
        throw validationFailedError(requestId, 'Invalid cursor.', {
          fieldErrors: { cursor: ['cursor is not a valid opaque cursor'] },
        });
      }
    }

    const access = await resolveAuditAccess(principal);
    if (!access) {
      throw forbiddenError(
        requestId,
        'Requires a workspace admin, a platform super-admin, or a first-party app credential.',
        { reason: 'admin_or_owner_required' }
      );
    }

    const values: unknown[] = [];
    const whereClauses: string[] = [];

    if (!access.owner) {
      values.push(access.workspaceId);
      const workspaceParam = `$${values.length}`;
      whereClauses.push(
        `(app_client_id IN (SELECT client_id FROM oauth_apps WHERE workspace_id = ${workspaceParam}) ` +
          `OR (app_client_id IS NULL AND user_id IN (SELECT user_id FROM workspace_memberships WHERE workspace_id = ${workspaceParam})))`
      );
    }

    if (appClientIdFilter !== undefined) {
      values.push(appClientIdFilter);
      whereClauses.push(`app_client_id = $${values.length}`);
    }

    if (decodedCursor) {
      values.push(decodedCursor.created_at, decodedCursor.id);
      whereClauses.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
    }

    values.push(limit + 1);
    const limitParamIndex = values.length;

    const result = await pool.query<AuditRow>(
      `SELECT ${AUDIT_COLUMNS}
       FROM public_api_audit
       ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitParamIndex}`,
      values
    );

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];
    // created_at_precise, not lastRow.created_at.toISOString() — see
    // AUDIT_COLUMNS's comment for why the latter would silently drop rows.
    const nextCursor =
      hasMore && lastRow
        ? encodeCursor({ id: lastRow.id, created_at: preciseTimestamp(lastRow.created_at_precise) })
        : null;

    res.status(200).json({
      data: page.map(serializeAuditRow),
      next_cursor: nextCursor,
    });
  })
);
