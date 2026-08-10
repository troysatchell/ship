-- Migration 042: oauth_apps (PF-101 / TRO-406)
--
-- First table of PlugForge's OAuth layer (PLUGFORGE.MD §2.2). An oauth_app is
-- a registered client of the public API (a portal-registered app, a Slack
-- integration, FleetGraph itself, the grader's own test app) — distinct from
-- an end user. Columns follow §2.2's table exactly, with one PM-triage
-- amendment (2026-08-10, this ticket's comments): the §2.2 table omitted a
-- confidential/public distinction, but PF-104's "client auth for confidential
-- clients" AC is unimplementable without it, so this migration also adds it.
--
-- confidential vs public (PM amendment):
--   - public:       PKCE-mandatory, secretless at the token endpoint (browser
--                    PKCE demo — no secret can be kept safe in client-side JS).
--                    client_secret_hash is NULL for these rows.
--   - confidential: secret required at the token endpoint (Slack, FleetGraph,
--                    the grader app). client_secret_hash is populated.
-- The CHECK enforces the enum; whether a given app actually carries a secret
-- consistent with its client_type is an application-layer invariant enforced
-- at app-registration time (PF-102/PF-103), not a DB constraint — mirrors how
-- api_tokens.expires_at (NULL = never expires) is an app-level, not DB-level,
-- rule.
--
-- Hash pattern: SHA-256, same as api_tokens.token_hash
-- (api/src/routes/api-tokens.ts) — the plaintext client_secret is shown to
-- the app owner exactly once at registration/rotation and never stored.
--
-- redirect_uris/requested_scopes are text[] rather than a join table: both are
-- small, app-owned, whole-value-replaced-on-edit lists (redirect URI set,
-- requested scope set), not independently queried or joined against — the
-- same shape api_tokens/oauth_tokens use for `scopes`.
CREATE TABLE IF NOT EXISTS oauth_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  -- PM amendment (2026-08-10): confidential/public client distinction,
  -- required by PF-104 but absent from the §2.2 table as originally drafted.
  client_type TEXT NOT NULL CHECK (client_type IN ('confidential', 'public')),
  -- Nullable per the same PM amendment: public clients never hold a secret.
  client_secret_hash TEXT,
  redirect_uris TEXT[] NOT NULL DEFAULT '{}',
  requested_scopes TEXT[] NOT NULL DEFAULT '{}',
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  is_first_party BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

-- client_id (ship_app_...) is the public identifier apps present at every
-- OAuth endpoint; the token/authorize routes look apps up by it, so it must
-- both be unique and be backed by an index (unqualified UNIQUE would add an
-- index anyway, but this is explicit for parity with the other new tables'
-- hash-column indexes below, and so the AC's "\d evidence" shows it by name).
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_apps_client_id ON oauth_apps (client_id);

-- Supporting index: the portal's "list my workspace's registered apps" query
-- (§2.9) filters by workspace_id — same convention as idx_api_tokens_workspace_id.
CREATE INDEX IF NOT EXISTS idx_oauth_apps_workspace_id ON oauth_apps (workspace_id);

-- FK-lookup index: owner_user_id backs "list apps I own" lookups and is
-- scanned on every referencing user's delete (ON DELETE SET NULL) — same
-- convention as the FK indexes below (CodeRabbit finding, PF-101).
CREATE INDEX IF NOT EXISTS idx_oauth_apps_owner_user_id ON oauth_apps (owner_user_id);
