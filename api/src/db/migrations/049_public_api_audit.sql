-- Migration 049: public_api_audit (PF-501 / TRO-432)
--
-- PLUGFORGE.MD §2.2 lists this as migration "046", but that number was
-- consumed months ago (046_oauth_device_codes_polling.sql, PF-105/PF-106).
-- Renumbered to the next available slot as of this ticket's dispatch
-- (verified fresh via `ls api/src/db/migrations/ | sort -V | tail -5` before
-- writing this file: 044-048 all taken) — same renumbering situation
-- 046/047/048 already document in their own headers for PF-105/PF-106/
-- PF-302/PF-304.
--
-- One row per `/api/v1` request (PLUGFORGE.MD §2.7, §4 PF-501), written by
-- `platform/audit/middleware.ts`'s fire-and-forget INSERT on
-- `res.on('finish')` — see that file's header for the write path. Columns
-- match §2.7's listed set exactly: request_id, app_client_id, user_id,
-- method, route, scope_used, status, latency_ms, created_at.
--
-- Nullability: only request_id/method/route/status/latency_ms/created_at are
-- NOT NULL — the middleware can always know those. app_client_id/user_id/
-- scope_used all tolerate NULL because a request can fail, or simply need
-- none of them, before that information exists:
--   - app_client_id is NULL for a personal-token principal (Principal.app is
--     always null for that class — platform/oauth/principal.ts) and for any
--     request that never resolves a principal at all (a 401 from a missing/
--     invalid bearer token, or a genuinely public route like GET /health).
--   - user_id is NULL for a Client Credentials principal (no acting user)
--     and for the same never-resolved-a-principal cases above.
--   - scope_used is NULL for any route with no requireScope(...) in its
--     chain (GET /health, /openapi.json, /me) and for a request rejected by
--     bearerAuth before a scope check is ever reached.
--
-- app_client_id is TEXT, not a UUID FK to oauth_apps.id: it mirrors
-- oauth_apps.client_id's own type (migration 042, `ship_app_...` strings)
-- and is deliberately NOT a foreign key of any kind (same for user_id ->
-- users.id) — an audit row is a historical record of what happened, and
-- must survive the referenced app/user being deleted unchanged, exactly the
-- same "the trail outlives the thing it describes" property audit_logs
-- already has for actor_user_id (schema.sql, ON DELETE SET NULL — this
-- table goes one step further and takes no FK action at all, since there is
-- no ON DELETE behavior to choose between when there is no constraint).
CREATE TABLE IF NOT EXISTS public_api_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id TEXT NOT NULL,
  app_client_id TEXT,
  user_id UUID,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  scope_used TEXT,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-app query index — PF-501's own AC ("queryable per app"): GET
-- /api/v1/audit's optional ?app_client_id= filter, and the workspace-scoping
-- join resources/audit.ts's GET / builds (an admin's own workspace's apps),
-- both filter on this column first.
CREATE INDEX IF NOT EXISTS idx_public_api_audit_app_client_id ON public_api_audit (app_client_id);

-- Per-user query index — the workspace-scoping query's other branch (a
-- personal-token call, app_client_id NULL) filters on this column instead,
-- to find rows belonging to members of the caller's own workspace.
CREATE INDEX IF NOT EXISTS idx_public_api_audit_user_id ON public_api_audit (user_id);

-- Keyset-pagination index: GET /api/v1/audit orders by (created_at DESC, id
-- DESC) — same cursor shape as platform/api/v1/pagination.ts, same
-- convention as idx_webhook_subscriptions_created_at_id (migration 047) /
-- idx_webhook_deliveries_created_at_id (migration 048).
CREATE INDEX IF NOT EXISTS idx_public_api_audit_created_at_id ON public_api_audit (created_at DESC, id DESC);
