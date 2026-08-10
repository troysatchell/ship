-- Migration 043: oauth_authorization_codes, oauth_tokens, oauth_device_codes,
-- and api_tokens.scopes (PF-101 / TRO-406)
--
-- Second half of PlugForge's OAuth schema (PLUGFORGE.MD §2.2), completing the
-- three OAuth grant flows (authorization code + PKCE, client credentials,
-- device) plus the "scoped personal token" extension that lets PF-107's v1
-- bearer middleware accept a second token class through the *existing*
-- api_tokens mechanism instead of minting per-user OAuth tokens for
-- first-party surfaces (the portal, PF-703's gated writes).
--
-- TTLs (§2.2 — enforced by application code in PF-104/105/106, not by this
-- migration; these tables only carry the expires_at column the TTL is
-- written into):
--   access tokens:  1 hour
--   refresh tokens: 30 days, one-time-use with rotation; reuse of an already-
--                   rotated refresh token revokes the whole family_id
--                   (stolen-refresh-token detection)
--   auth codes:     10 minutes, single-use (consumed_at)
--
-- Hash pattern for every *_hash column below: SHA-256, same as
-- api_tokens.token_hash (api/src/routes/api-tokens.ts) — only the hash is
-- stored, the bearer value is shown/returned once at issuance.

-- oauth_authorization_codes: the short-lived code exchanged for a token pair
-- in the authorization_code + PKCE flow. code_challenge_method is
-- constrained to S256 only (§2.2: "S256 only") — the plain PKCE method is
-- deliberately not supported.
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash TEXT NOT NULL,
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256' CHECK (code_challenge_method = 'S256'),
  redirect_uri TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_authorization_codes_code_hash
  ON oauth_authorization_codes (code_hash);
CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_app_id
  ON oauth_authorization_codes (app_id);

-- oauth_tokens: access + refresh token pairs for all three grants.
-- user_id is nullable — Client Credentials grant issues an app-only token
-- with no acting user (§2.2: "nullable — null for Client Credentials").
-- refresh_token_hash is nullable — not every grant issues a refresh token.
-- family_id groups a token and every token it was rotated into; parent_id
-- points at the token this one was rotated from (self-referential, ON DELETE
-- SET NULL so purging an old parent never cascades into deleting its still-
-- live children).
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  access_token_hash TEXT NOT NULL,
  refresh_token_hash TEXT,
  family_id UUID NOT NULL DEFAULT gen_random_uuid(),
  parent_id UUID REFERENCES oauth_tokens(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_tokens_access_token_hash
  ON oauth_tokens (access_token_hash);
-- Partial: refresh_token_hash is NULL for grants that issue no refresh token
-- (Client Credentials), and a plain UNIQUE index already treats NULLs as
-- distinct in Postgres — the WHERE clause just makes that intent explicit
-- rather than relying on the reader knowing Postgres's NULL-uniqueness rule.
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_tokens_refresh_token_hash
  ON oauth_tokens (refresh_token_hash) WHERE refresh_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_app_id ON oauth_tokens (app_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_id ON oauth_tokens (user_id);
-- Stolen-refresh-token detection revokes an entire family in one statement
-- (UPDATE ... WHERE family_id = $1) — needs an index or that revocation
-- itself seq-scans the table on every reuse detection.
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family_id ON oauth_tokens (family_id);

-- oauth_device_codes: RFC 8628 device authorization grant. user_code is the
-- short human-typable code (e.g. BDWJ-KXQT) shown on the device and entered
-- at the verification URL; device_code_hash is the long-lived secret the
-- device itself polls with. status starts 'pending' and moves to
-- 'approved'/'denied' once a user acts, or 'expired' past expires_at.
CREATE TABLE IF NOT EXISTS oauth_device_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash TEXT NOT NULL,
  user_code TEXT NOT NULL,
  app_id UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  interval_seconds INTEGER NOT NULL DEFAULT 5,
  expires_at TIMESTAMPTZ NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_device_codes_device_code_hash
  ON oauth_device_codes (device_code_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_device_codes_user_code
  ON oauth_device_codes (user_code);
CREATE INDEX IF NOT EXISTS idx_oauth_device_codes_app_id
  ON oauth_device_codes (app_id);

-- api_tokens.scopes (§2.2, same migration as the row above states): extends
-- the EXISTING personal-access-token mechanism (schema.sql:254-267 — no
-- scopes column today) rather than adding a new table, so PF-107's v1 bearer
-- middleware can accept "scoped personal tokens" as its second token class
-- (app-less: user + scopes) alongside real OAuth access tokens (app +
-- optional user). NULL = legacy unscoped internal token, unchanged behavior,
-- never valid at /api/v1 — non-null = a scoped personal token minted with an
-- explicit scopes argument (§2.9's portal, PF-703's gated writes). Existing
-- rows get NULL from the column default, which is exactly the "legacy
-- unscoped" case — no backfill needed, and the ALTER is safe on a non-empty
-- table (adding a nullable column never rewrites existing rows' data).
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS scopes TEXT[];
