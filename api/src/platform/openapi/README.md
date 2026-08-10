# `platform/openapi/`

v1 OpenAPI 3.1 registry + generator, served at `/api/v1/openapi.json`
(PLUGFORGE.MD §2.1; Epic E2 — PF-202). A separate registry instance from the
existing internal one (`api/src/openapi/registry.ts`) — same zod-to-openapi
pattern, new instance, because `/api/v1` and `/api/*` are documented
separately (§2.1's boundary rule). Empty until PF-202 lands; `/api/v1/health`
(PF-001) is not yet registered anywhere — see
`api/src/platform/api/v1/router.ts`'s header comment.
