# `platform/openapi/`

v1 OpenAPI 3.1 registry + generator, served at `/api/v1/openapi.json`
(PLUGFORGE.MD §2.1; Epic E2 — PF-202, Linear TRO-402). A separate
`OpenAPIRegistry` instance from the existing internal one
(`api/src/openapi/registry.ts`) — same zod-to-openapi pattern, new instance,
because `/api/v1` and `/api/*` are documented separately (§2.1's boundary
rule) and because this document targets OpenAPI 3.1 (`OpenApiGeneratorV31`)
while the internal one stays 3.0.

## Layout

- `registry.ts` — the `v1Registry` instance, the `bearerAuth` security
  scheme, and `generateV1OpenAPIDocument()`. Mirrors
  `api/src/openapi/registry.ts`'s shape, not its content.
- `schemas/` — one file per resource, each calling `v1Registry.registerPath`
  as an **import side effect** (mirrors `api/src/openapi/schemas/*.ts`).
  `schemas/index.ts` is the barrel; `index.ts` at this directory's root
  imports that barrel before re-exporting the registry/generator, so any
  consumer that imports `platform/openapi/index.ts` is guaranteed every
  path is registered before it calls `generateV1OpenAPIDocument()`.
- `schemas/common.ts` — `ApiErrorSchema`, the Zod mirror of
  `platform/api/v1/errors.ts`'s `ApiErrorBody` (§2.5), shared across every
  resource's error responses.
- `schemas/platform.ts` — registers `GET /health` (PF-001) and `GET
  /openapi.json` (this document's own endpoint, PF-202) — both public, no
  bearer auth.
- `schemas/documents.ts` — registers PF-200's three `/documents` routes,
  importing `ListDocumentsQuerySchema` / `CreateDocumentRequestSchema` /
  `DocumentTypeSchema` from `platform/api/v1/resources/documents.ts` (that
  file `export`s them for exactly this purpose) rather than redefining them.
  The response shape (`DocumentResponseSchema` / `DocumentListResponseSchema`)
  is new here — `resources/documents.ts` never had a Zod schema for its
  response, only the `serializeDocument()` function and a TS interface — so
  this file builds one that matches `serializeDocument()`'s actual output
  field-for-field.

- `schemas/issues.ts` / `schemas/sprints.ts` / `schemas/me.ts` — registers
  PF-201's `/issues`, `/sprints`, `/me` routes. Added by PF-203 (Linear
  TRO-404), closing a real gap: PF-201 landed on a sibling branch concurrently
  with PF-202 and was never retrofitted with `registerPath` calls, so those
  three routes had no OpenAPI entry from PF-202's merge until this ticket.
  `route-fitness.test.ts` (`platform/api/v1/__tests__/`) is the drift gate
  that exists specifically so this class of gap fails CI going forward,
  instead of silently persisting the way this one did.

## Scope note (PF-202/PF-203, as shipped)

Registers every route that exists on `/api/v1`: `GET /health`, `GET
/openapi.json`, PF-200's three `/documents` routes, and PF-201's `/issues`,
`/sprints`, `/me` (the last three added by PF-203 — see above).

## Verifying it

```bash
curl -s http://localhost:3000/api/v1/openapi.json | python3 -m json.tool | head -30
```

The unit tests in `__tests__/` do the same thing two ways: one confirms the
route serves a document containing every route above, the other validates
the generated document against the real, official OpenAPI 3.1 JSON Schema
(`@seriousme/openapi-schema-validator`, `ajv/dist/2020` under the hood — see
that test file's header comment for why a hand-rolled `ajv` + the raw
`spec.openapis.org` schema hit a documented `$dynamicRef` /
`unevaluatedProperties` interaction bug in `ajv` 8.x, and why this dependency
was chosen instead of wiring `ajv` directly).
