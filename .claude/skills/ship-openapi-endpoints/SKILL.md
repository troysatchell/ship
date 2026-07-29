---
name: ship-openapi-endpoints
description: >-
  The three-file pattern for adding or changing a Ship API endpoint — zod schema plus
  `registry.registerPath`, the route handler, and the mount in `app.ts` — including the `/api`
  server-prefix rule, why `summary`/`description` decide whether the generated MCP tool is usable,
  and how to verify the endpoint actually reached Swagger. Use when adding, renaming, or changing
  any `/api/*` endpoint.
---

# Adding an API endpoint

**All API routes must be registered with OpenAPI.** Skipping registration does not break the
endpoint — it breaks two things downstream, silently: Swagger stops documenting it, and the MCP
server stops exposing it as a tool. Both failures look like nothing happening.

Three files, in this order.

## 1. Schema + path registration — `api/src/openapi/schemas/<resource>.ts`

Define the zod schemas, then register the path:

```typescript
import { registry, z } from '../registry.js';
import { UuidSchema } from './common.js';

registry.registerPath({
  method: 'get',
  path: '/issues/{id}',            // NO /api prefix — see below
  tags: ['Issues'],
  summary: 'Get issue by ID',      // becomes the MCP tool description
  request: {
    params: z.object({ id: UuidSchema }),
  },
  responses: {
    200: {
      description: 'Issue details',
      content: { 'application/json': { schema: IssueResponseSchema } },
    },
  },
});
```

Working examples to copy: `api/src/openapi/schemas/issues.ts:233` (list with query filters) and
`:269` (get by id with `params`). Reuse `UuidSchema` and friends from `schemas/common.ts` rather than
redeclaring them.

Then make sure the file is imported by `api/src/openapi/schemas/index.ts` — registration happens as
an **import side effect**. `api/src/openapi/index.ts` imports that barrel; a schema file nobody
imports registers nothing and fails silently.

### Three details that are easy to get wrong

**No `/api` prefix in `path`.** `api/src/openapi/registry.ts:73-78` sets
`servers: [{ url: '/api' }]`, so `path: '/issues'` documents `/api/issues` — which is where
`app.ts:189` actually mounts it. Writing `path: '/api/issues'` produces `/api/api/issues` in the
spec.

**`summary` and `description` are not decoration.** `api/src/mcp/server.ts:338-346` builds each MCP
tool's description by joining `operation.summary`, `operation.description`, and
`` `[${METHOD} ${path}]` ``. Omit both and the tool ships with `[GET /issues]` as its entire
description — technically present, unusable by an agent choosing between tools.

**`operationId` is optional but sets the tool name.** Without it, `pathToOperationId(method, path)`
generates one. Set it when the derived name would be ugly or ambiguous.

## 2. The route handler — `api/src/routes/<resource>.ts`

```typescript
router.get('/:id', authMiddleware, async (req: Request, res: Response) => { ... });
```

- **`authMiddleware` goes on each route**, not on the mount — that is the established pattern
  (`api/src/routes/issues.ts:115, 246, 493, 563, …`). A route without it is public; make that a
  deliberate choice, not an omission.
- Validate the request body with the same zod schema you registered. Two sources of truth for one
  shape is how the docs drift from the behaviour.
- Parameterize every SQL value (`$1`, `$2`). Identifiers cannot be parameterized — validate them
  against an allowlist first. See `/ship-backend`.

## 3. Mount it — `api/src/app.ts`

```typescript
app.use('/api/issues', conditionalCsrf, issuesRoutes);
```

- **`conditionalCsrf` is the default.** Nearly every router carries it (`app.ts:176-200`). The
  exceptions are deliberate — `/api/claude` and `/api/search` do not (`app.ts:203, 206`). If you
  believe your router is an exception, that is a security decision and it escalates.
- `app.use('/api/', apiLimiter)` at `app.ts:140` rate-limits everything under `/api` already. Do not
  add a second limiter unless the endpoint needs a stricter one (the login limiter at `:182` is the
  model).
- Multiple routers can share a mount path — `/api/documents` carries documents, backlinks, and
  associations (`app.ts:186-188`).

## Verify it landed

```bash
pnpm --filter @ship/api openapi:generate     # writes api/src/openapi.yaml + openapi.json
```

`generateOpenApiFile()` (`api/src/swagger.ts:94-102`) writes both files. With the server running,
also check:

- `GET /api/openapi.json` — the live spec (`swagger.ts:39`). This is the exact URL the MCP server
  fetches (`api/src/mcp/server.ts:129`), so if your path is missing here, there is no MCP tool.
- `/api/docs` — Swagger UI (`swagger.ts:26`).

The MCP tools are generated **at runtime** from that URL, not at build time. There is nothing to
regenerate on the MCP side; restart it and the tool appears.

## Checklist

- [ ] Schema file registers the path and is reachable from `schemas/index.ts`.
- [ ] `path` has **no** `/api` prefix.
- [ ] `tags`, `summary`, and a real `description` are set.
- [ ] Response schemas registered for every status code the handler returns — including errors.
- [ ] `authMiddleware` on the route, or a written reason it is public.
- [ ] Mounted in `app.ts` with `conditionalCsrf` unless deliberately excepted.
- [ ] A supertest test beside the route (`api/src/routes/<resource>.test.ts`).
- [ ] Path visible in `/api/openapi.json` after `openapi:generate`.
