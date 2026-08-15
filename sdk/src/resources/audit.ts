/**
 * `audit` resource client (PF-501/TRO-432's own follow-through into
 * `@ship/sdk`, required by PF-405's parity fitness test — `sdk/src/__tests__/
 * parity.test.ts` fails on any registered `/api/v1` operation with no typed
 * SDK method and no documented exemption; `GET /audit` is a substantive
 * domain resource, not an infra/meta endpoint like `/health`, so it earns a
 * real method here rather than an `OPENAPI_EXEMPTIONS` entry — see that
 * file's own header for why the exemption table is reserved for the
 * infra/meta case specifically).
 *
 * Server route: `api/src/platform/api/v1/resources/audit.ts` (real, merged
 * in the same PR as this file) — read that file's header before touching
 * this one; it owns the full "admin/owner-scoped" authorization design this
 * client's doc comments only summarize. `AuditRow`'s fields mirror that
 * file's `serializeAuditRow()` return shape exactly, field-for-field.
 *
 * SCOPE NOTE: only `list()` exists, because the server registers only
 * `GET /audit` — no create/get-by-id/delete (an audit trail is
 * write-once-by-the-system, read-only to every caller).
 */
import type { RequestClient } from '../internal/requestClient.js';
import type { ListPage } from '../types.js';

const AUDIT_PATH = '/api/v1/audit';

/**
 * One `public_api_audit` row, exactly as `resources/audit.ts`'s
 * `serializeAuditRow()` returns it. `app_client_id`/`user_id`/`scope_used`
 * are independently nullable — see that file's own header for exactly when
 * each is null (an unauthenticated request, a Client Credentials call with
 * no acting user, a route with no `requireScope(...)` in its chain).
 */
export interface AuditRow {
  readonly id: string;
  readonly request_id: string;
  readonly app_client_id: string | null;
  readonly user_id: string | null;
  readonly method: string;
  readonly route: string;
  readonly scope_used: string | null;
  readonly status: number;
  readonly latency_ms: number;
  readonly created_at: string;
}

export interface ListAuditParams {
  readonly limit?: number;
  readonly cursor?: string;
  /** Narrows to one app's calls — PF-501's own AC, "queryable per app". */
  readonly app_client_id?: string;
}

export type AuditRowList = ListPage<AuditRow>;

export class AuditClient {
  constructor(private readonly request: RequestClient) {}

  /** `GET /api/v1/audit` — cursor-paginated audit trail. Requires the
   *  caller's token to hold `audit:read` AND resolve to a workspace admin,
   *  a platform super-admin ("owner"), or a first-party app credential —
   *  a missing/invalid token throws `ShipSdkError` with `kind: 'auth'`
   *  (401); a valid token that fails either check throws `kind: 'forbidden'`
   *  (403) — the server's `forbidden` ApiErrorCode maps to `'forbidden'`,
   *  not `'auth'` (see `errors.ts#CODE_TO_KIND`). Same mapping as every
   *  other scope/role-gated route this SDK talks to (CodeRabbit, this PR's
   *  review — the prior wording of this comment claimed `kind: 'auth'` for
   *  the 403 case, which was wrong). */
  async list(params: ListAuditParams = {}): Promise<AuditRowList> {
    return this.request.get<AuditRowList>(AUDIT_PATH, {
      limit: params.limit,
      cursor: params.cursor,
      app_client_id: params.app_client_id,
    });
  }
}
