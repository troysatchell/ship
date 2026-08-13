-- Migration 044: oauth_tokens.authorization_code_id (PF-104 / TRO-416)
--
-- Links a token row minted by the authorization_code grant back to the
-- oauth_authorization_codes row that was redeemed to create it.
--
-- Why this is needed: PLUGFORGE.MD §4's PF-104 acceptance criterion is
-- explicit — "reused code -> invalid_grant + revoke tokens issued from it".
-- Migration 043's oauth_tokens table has no column linking a token back to
-- the code that minted it, so a reuse attempt has no way to find which
-- row(s) to revoke. Checked before adding this (per this ticket's own
-- instructions): 043's oauth_authorization_codes/oauth_tokens columns were
-- read in full first — neither table carries this linkage today.
--
-- NULL for every token NOT minted by redeeming a code: Client Credentials
-- grant always leaves this NULL (no code involved at all), and any future
-- Device Authorization Grant token (PF-106) would too.
--
-- ON DELETE SET NULL, not CASCADE: there is no authorization-code garbage
-- collection job today, but if one is ever added, deleting an old, already-
-- consumed code row must never cascade into deleting a still-live access/
-- refresh token pair that happens to trace back to it — the token's own
-- lifecycle (expiry, revocation) is independent of the code's row existing.
--
-- Migration-number note for the orchestrator: PLUGFORGE.MD §2.2 earmarks 044
-- for `webhook_subscriptions` (a PF-3xx-series ticket). As of this branch,
-- no sibling worktree (checked: feat/pf-300-event-registry,
-- feat/pf-303-hmac-signer, feat/pf-107-scopes-bearer, feat/pf-900-terraform-w6,
-- feat/pf-907-grader-access — none had a migration past 043) had claimed 044,
-- so this ticket takes it. If a webhook-series branch also lands a 044 before
-- this merges, one of the two needs renumbering at integration time — same
-- reconciliation class already documented for CHANGES.md convoy conflicts.
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS authorization_code_id UUID
  REFERENCES oauth_authorization_codes(id) ON DELETE SET NULL;

-- Supporting index: the reuse-detection path looks up "which token(s) did
-- this code mint" by authorization_code_id on every redemption attempt that
-- finds the code already consumed (whether from a genuine replay or from
-- losing the single-use race — see token.ts). Partial index since the vast
-- majority of rows (every Client Credentials token) will always be NULL here.
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_authorization_code_id
  ON oauth_tokens (authorization_code_id) WHERE authorization_code_id IS NOT NULL;
