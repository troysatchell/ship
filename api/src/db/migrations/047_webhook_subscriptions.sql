-- Migration 047: webhook_subscriptions (PF-302 / TRO-431)
--
-- PLUGFORGE.MD §2.2 lists this as migration "044", but that number was
-- consumed months ago by PF-104's OAuth work
-- (044_oauth_tokens_authorization_code_id.sql). Renumbered to the next
-- available slot as of this ticket's dispatch (verified fresh via
-- `ls api/src/db/migrations/ | sort -V | tail -3` before writing this file:
-- 042/043/044/045/046 all taken) — same renumbering situation
-- 046_oauth_device_codes_polling.sql documents in its own header for
-- PF-105/PF-106.
--
-- Columns match §2.2's table row for `webhook_subscriptions` exactly: `id`,
-- `app_id`, `event_type`, `target_url`, `signing_secret_ciphertext`
-- (AES-256-GCM under env `SECRET_ENCRYPTION_KEY`), `active bool`,
-- `created_at`.
--
-- Signing-secret storage (§2.2 note, restated in docs/architecture.md's
-- "Documented Deviations"): the brief says "hashed signing secret", but the
-- server must POSSESS the secret at delivery time to compute the HMAC
-- signature (`platform/webhooks/signer.ts`, PF-303) — a one-way hash is
-- unimplementable for that. `signing_secret_ciphertext` therefore holds an
-- AES-256-GCM ciphertext, not a hash: the 12-byte IV, 16-byte auth tag, and
-- encrypted `whsec_...` secret, base64-encoded together into one blob
-- (`platform/webhooks/secretEncryption.ts` owns the packing/unpacking) —
-- one TEXT column, matching this table's single `signing_secret_ciphertext`
-- column rather than splitting IV/tag into sibling columns the PRD's table
-- doesn't list. Same "one column, plaintext shown once, ciphertext at rest"
-- shape `oauth_apps.client_secret_hash` already established for OAuth app
-- secrets (migration 042) — the only difference is encrypt-to-recover
-- instead of hash-to-compare, because an HMAC signer needs the former.
--
-- `event_type` validation — deliberately APPLICATION-level (zod, against
-- `platform/webhooks/events.ts`'s `EVENT_TYPES`/`eventRegistry`), not a DB
-- CHECK constraint enumerating the 8 event-type strings here. A CHECK
-- constraint would duplicate that list as a second, migration-frozen source
-- of truth alongside `events.ts`'s `EVENT_DEFINITIONS` map — exactly what
-- that file's own header calls out as the thing PF-300's "events as data"
-- design avoids ("adding a 9th event type is adding one entry [to
-- EVENT_DEFINITIONS], never a new branch anywhere else"). A 9th event type
-- would need this CHECK constraint dropped and re-added in a follow-up
-- migration if enforced here, but would need no schema change at all if left
-- to the application-layer zod schema
-- (`platform/api/v1/resources/webhooks.ts`'s `WebhookEventTypeSchema =
-- z.enum(EVENT_TYPES)`) — the OCP property this codebase already prizes for
-- scopes (`ScopeRegistry`) and events. `event_type` is plain TEXT here, not
-- constrained by the database, on that basis.
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  target_url TEXT NOT NULL,
  -- Base64 of (12-byte IV || 16-byte GCM auth tag || AES-256-GCM
  -- ciphertext) — see the header note above.
  signing_secret_ciphertext TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- FK-lookup index: every /api/v1/webhooks list/get/delete/rotate query joins
-- to oauth_apps on app_id to resolve the caller's workspace (webhook
-- subscriptions carry no workspace_id of their own — they belong to an app,
-- which belongs to exactly one workspace, per §2.2), and this is also the
-- column CASCADE-deletes scan on an oauth_apps delete. Same FK-index
-- convention as idx_oauth_apps_owner_user_id (migration 042).
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_app_id ON webhook_subscriptions (app_id);

-- Supporting index for the future subscription matcher (§2.6's
-- "subscription matcher" pipeline stage, PF-304 — not built by this
-- ticket): resolving "which active subscriptions want event X" filters by
-- event_type (and active) far more often than it scans an app's whole
-- subscription list. Cheap to add now, expensive to discover missing once
-- PF-304 lands and every delivery does a sequential scan.
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_event_type ON webhook_subscriptions (event_type) WHERE active;

-- Keyset-pagination index: GET /api/v1/webhooks orders by (created_at DESC,
-- id DESC) — same cursor shape as platform/api/v1/pagination.ts — scoped
-- per-app via the FK index above and this composite for the ORDER BY itself.
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_created_at_id ON webhook_subscriptions (created_at DESC, id DESC);
