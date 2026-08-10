# `platform/oauth/`

OAuth 2.0 flows, endpoints, PKCE, token issuance/rotation (PLUGFORGE.MD §2.1,
Epic E1 — PF-100 through PF-107). App registration (PF-102), `/oauth/authorize`
(PF-103), `/oauth/token` (PF-104), refresh rotation (PF-105), and the device
grant (PF-106) still land here as their own tickets; this directory exists
now so they build inside the scaffold rather than inventing a new location.

**What's here today (PF-107, TRO-430):**

- `principal.ts` — the `Principal`/`PrincipalApp`/`PrincipalUser` shapes and
  the `req.principal` Express augmentation.
- `bearerAuth.ts` — the v1 bearer-token middleware. Accepts two token
  classes (an OAuth access token from `oauth_tokens`, or a scoped personal
  token from `api_tokens` where `scopes IS NOT NULL`) and populates
  `req.principal`. 401s carry a closed three-value `details.reason`
  (`missing_token` / `invalid_token` / `expired_token`).
- `apiError.ts` — a **local, ticket-scoped** construction of the §2.5
  `ApiError` JSON shape. Flagged for consolidation once PF-002 (`ApiError` +
  public error middleware, built on a separate branch in parallel with this
  one) lands — see the file header for why it isn't imported from there
  today.

`ScopeRegistry` and `requireScope(scope)` live in `../scopes/` — see that
directory's README.
