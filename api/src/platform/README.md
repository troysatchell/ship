# `api/src/platform/` — the platform layer

New public-facing API surface for Ship (PlugForge, Week 6). This is the layout
mandated by `PLUGFORGE.MD` §2.1 — later platform tickets add files inside the
directories below; this ticket (PF-001) only populates `api/v1/`.

```text
api/src/platform/
  oauth/      flows, endpoints, PKCE, token issuance/rotation        (E1 — PF-10x)
  scopes/     ScopeRegistry (scopes as data)                         (E1 — PF-107)
  ratelimit/  token buckets + header middleware                      (E5 — PF-500)
  webhooks/   event registry, IEventBus, signer, deliverer, DLQ, replay (E3 — PF-30x)
  audit/      public API audit trail                                 (E5 — PF-501)
  api/v1/     the public router: resources, ApiError, pagination     (E0/E2 — PF-001, PF-002, PF-2xx)
  openapi/    v1 OpenAPI 3.1 registry + generator                    (E2 — PF-202)
```

## Boundary rules (§2.1, enforced by lint starting PF-003)

- `api/src/platform/api/v1/**` must not import from `api/src/routes/**`
  (internal handlers). Both layers call the same domain services.
- Public routes live only at `/api/v1/*`; internal endpoints stay at `/api/*`.
- The `/api/v1` router shares **no route-specific auth/CSRF/rate-limit
  middleware** with internal routes (the per-route `conditionalCsrf`,
  `authMiddleware`, and endpoint-specific limiters like `loginLimiter` never
  apply to it). App-global middleware (helmet, compression, CORS, body/cookie
  parsing, session — `api/src/app.ts`) still runs on both, since it is wired
  before either router mounts — and so do the legacy per-source-IP/
  per-identity `express-rate-limit` limiters mounted on `/api/`, which still
  match `/api/v1` by prefix today; exempting `/api/v1` from those is PF-004's
  job (see `ratelimit/README.md`), not done by this ticket.
- **`agent/` is a permitted `@ship/sdk` consumer (PF-702, TRO-428)** —
  integrations-equivalent status, per PLUGFORGE.MD's own framing: "the agent
  is a platform client." `scripts/check-integration-deps.mjs`'s "one runtime
  dependency, `@ship/sdk` only" rule scans `integrations/*` exclusively and
  deliberately does NOT scan `agent/` — that script's own header states why
  (`agent/` keeps its existing, non-`@ship/sdk` runtime deps, e.g. Express,
  LangGraph). This is the one place `agent/` reaches across the
  `platform/api/v1/**` boundary above, and it does so the same way any other
  `@ship/sdk` consumer would: through the published `/api/v1/*` surface, not
  by importing `api/src/platform/**` directly — the one-way import ban above
  is unaffected. `AGENT_PLATFORM_MODE=sdk` (default `internal`) gates whether
  the agent's `ShipClient` (`agent/src/shipClient.ts`) actually delegates its
  10 reads through `@ship/sdk` at runtime; see that file's module docstring
  and CHANGES.md (TRO-428) for the mapping and the fields that could not
  carry over from the internal surface.

## Public CORS

The public API (`/api/v1/*`, and the future `/oauth` token/device endpoints)
will be bearer-token authenticated, once PF-107 lands (health is
unauthenticated by design) — not cookie/session authenticated — so it needs
a different CORS policy than the app-global one (`api/src/app.ts`'s
single-origin, `credentials: true` policy that backs the cookie-authenticated
SPA — that policy cannot serve a cross-origin bearer-token client, e.g.
PF-802's browser SDK demo).

`createPublicApiCors()` (`api/src/platform/publicCors.ts`) builds a separate,
permissive, **credential-less** (`credentials: false`) CORS policy, mounted in
`api/src/app.ts` on exactly `/api/v1/*` and `/oauth`.

**Env var: `PUBLIC_API_CORS_ORIGIN`**

| Value | Behavior |
|---|---|
| unset / empty / `*` | Allow any origin (`Access-Control-Allow-Origin: *`). Default — safe for local dev, CI, and the TTFE drill's throwaway containers, where the caller is not a real browser session and no origin is known ahead of time. |
| comma-separated list, e.g. `https://demo.example.com,http://localhost:5174` | Only those origins are allowed; the response reflects the matching request `Origin`. |

See `api/src/platform/config.ts` for the parsing (`resolvePublicApiCorsOrigin`)
and `terraform/render/` for where this gets set per-environment (added by a
later infra ticket, PF-900).
