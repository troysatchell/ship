# `platform/audit/`

Public API audit trail — writes a `public_api_audit` row per `/api/v1` call
(PLUGFORGE.MD §2.7, §2.1; Epic E5 — PF-501, Linear TRO-432).

- `middleware.ts` — `auditLogMiddleware`, mounted globally on `v1Router`
  (`platform/api/v1/router.ts`) right after `rateLimitDefaults`. Writes are
  fire-and-forget (`res.on('finish')`, after the response is already sent)
  so they never add latency to a caller's request, but the write itself is
  awaited and its failure logged, so a row is never silently dropped.
- The `GET /api/v1/audit` read endpoint lives at
  `platform/api/v1/resources/audit.ts` (not in this directory — it follows
  every other resource's location convention), with its own OpenAPI
  registration in `platform/openapi/schemas/audit.ts`. See that file's
  header for the "admin/owner-scoped" authorization design.
- Schema: migration `049_public_api_audit.sql`.
