# `platform/scopes/`

`ScopeRegistry` — scopes as data (PLUGFORGE.MD §2.3, §2.1; Epic E1 — PF-107,
TRO-430). New scopes register at module load; middleware is never edited to
add one.

- `registry.ts` — `ScopeRegistry`, registering §2.3's seven scopes
  (`documents:read`, `documents:write`, `issues:read`, `issues:write`,
  `sprints:read`, `sprints:write`, `webhooks:manage`) at module load. Adding
  an eighth scope means one more `ScopeRegistry.register(...)` call here —
  no other file changes.
- `requireScope.ts` — the "`require(scope)` middleware factory" PLUGFORGE.MD
  §4 names (exported as `requireScope`, not the literal identifier `require`
  — see the file header for why). Runs after `../oauth/bearerAuth.ts`; reads
  `req.principal.scopes` and returns `403` with `details.missing_scope` when
  the scope isn't present.
