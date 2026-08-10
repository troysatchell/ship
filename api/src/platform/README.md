# `api/src/platform/` — the platform layer

New public-facing API surface for Ship (PlugForge, Week 6). This is the layout
mandated by `PLUGFORGE.MD` §2.1 — later platform tickets add files inside the
directories below; this ticket (PF-001) only populates `api/v1/`.

```
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
- The `/api/v1` router shares **no internal auth/CSRF/rate-limit middleware**
  with internal routes. App-global middleware (helmet, compression, CORS,
  body/cookie parsing, session — `api/src/app.ts`) still runs on both, since
  it is wired before either router mounts.

## Public CORS

The public API (`/api/v1/*`, and the future `/oauth` token/device endpoints)
is bearer-token authenticated, not cookie/session authenticated, so it needs
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
