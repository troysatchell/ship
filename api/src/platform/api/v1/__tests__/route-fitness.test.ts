import { describe, it, expect } from 'vitest';
import request from 'supertest';
import type { Express, NextFunction, Request, Response, Router } from 'express';
import {
  getPath,
  isReferenceObject,
  type OperationObject,
  type PathItemObject,
  type SchemaObject,
  type ReferenceObject,
  type ComponentsObject,
} from 'openapi3-ts/oas31';
import { createApp } from '../../../../app.js';
import { v1Routes } from '../router.js';
import { v1OpenApiDocument } from '../../../openapi/index.js';

/**
 * PF-203 (Linear TRO-404, PLUGFORGE.MD §6) — the route-enumeration fitness
 * test: the drift gate for every `/api/v1` route.
 *
 * Walks the REAL, live `v1Routes` Express router stack (recursing into every
 * mounted sub-router: `documentsRouter`, `issuesRouter`, `sprintsRouter`,
 * `meRouter`, and whatever a future PF-2xx/PF-5xx ticket mounts) and, for
 * every route it finds, asserts:
 *
 *   (a) it has a `v1Registry.registerPath` entry in the generated
 *       `v1OpenApiDocument`, with a `security` requirement that matches
 *       whether `bearerAuth` is actually wired on the route;
 *   (b) it declares a scope via `requireScope(...)` — or is one of the
 *       small, explicitly documented exemptions below;
 *   (c) an actual HTTP round-trip against its generic failure path (missing
 *       auth, or an unsupported method) produces the §2.5 ApiError shape;
 *   (d) if it is a GET "collection" route (no `{param}` segment) it
 *       registers a `{ data: [...], next_cursor }` response shape — unless
 *       exempted as a known singleton GET.
 *
 * This is a STRUCTURAL walk, not a hand-maintained list of route names —
 * that was the exact failure mode PF-203 exists to prevent (a route added
 * after the list was last updated would silently stop being checked). The
 * "AC proof" section at the bottom of this file's PR description captures a
 * deliberately unregistered scratch route failing this suite, then reverted.
 *
 * No database fixtures: every check below is either pure structural
 * inspection of the live router/registry objects, or an HTTP request that
 * fails BEFORE any DB access (a missing bearer token is rejected by
 * `bearerAuth` before it queries `oauth_tokens`/`api_tokens`; an unmatched
 * method/path is rejected by `notFoundHandler` before any route handler
 * runs). This test can run standalone, with no seed data.
 *
 * Extensibility (architect note): a later ticket (PF-500) is expected to add
 * header assertions to this same walk. The per-route checks below are
 * intentionally separate `it(...)` blocks over one discovered route list —
 * add a fifth `it(...)` body under the same `describe.each` for a new
 * check-class rather than a parallel walk.
 */

// ─── Route discovery — walks the live router, not a hand-maintained list ──

interface RouteDescriptor {
  /** Lowercase HTTP method, e.g. 'get'. */
  method: string;
  /** Express-style full path, e.g. '/documents/:id'. */
  expressPath: string;
  /** OpenAPI-style full path, e.g. '/documents/{id}' — what `v1Registry`
   * keys its `registerPath` calls by. */
  openApiPath: string;
  /** Every middleware/handler layer name in this route's own stack, in
   * order (e.g. ['bearerAuth', 'requireScope(documents:read)', '<anonymous>']) —
   * Express's own `Layer.name`, which mirrors `fn.name`. */
  middlewareNames: string[];
  hasBearerAuth: boolean;
  /** The scope string captured from a `requireScope(scope)` layer, if any —
   * see `requireScope.ts`'s name-tagging, added by this ticket for exactly
   * this introspection. */
  declaredScope: string | null;
}

/** A `.use(path, subRouter)` mount layer's `.handle` is, at runtime, the
 * sub-router itself (callable + `.stack`) — but `ILayer.handle`'s static
 * type is only the callable signature. This type guard narrows it without
 * an `as any`/`as unknown as` cast: `'stack' in handle` is a plain runtime
 * check TypeScript accepts on any object-typed value (functions are
 * objects), and a user-defined type predicate is how TypeScript is told the
 * narrowed type — not a cast. */
type LayerHandle = (req: Request, res: Response, next: NextFunction) => unknown;

function isMountedRouterHandle(handle: LayerHandle): handle is LayerHandle & Router {
  return 'stack' in handle;
}

/**
 * Extracts a static (param-less) mount prefix from a `.use(path, router)`
 * layer's `regexp` — e.g. `/documents` from `/^\/documents\/?(?=\/|$)/i`.
 * Express (via path-to-regexp) does not expose the original mount-path
 * string on the layer object itself, only this compiled regexp.
 *
 * Deliberately throws (never silently mis-attributes a path) on any regexp
 * shape other than the exact one every CURRENT `/api/v1` mount produces —
 * verified against the real `v1Routes.stack` before writing this pattern.
 * A future mount with a parametrized or wildcard prefix needs this function
 * extended, not silently misread.
 */
function staticMountPrefix(regexp: RegExp): string {
  const match = /^\^((?:\\\/[a-zA-Z0-9._~-]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(regexp.source);
  const captured = match?.[1];
  if (!captured) {
    throw new Error(
      `route-fitness: unrecognized mount-layer regexp shape "${regexp.source}" — extend staticMountPrefix() in route-fitness.test.ts to handle it (e.g. a parametrized or wildcard mount prefix).`
    );
  }
  return captured.replace(/\\\//g, '/');
}

/** Reads the scope name off a `requireScope(scope)`-tagged layer name, if
 * this route's middleware stack has one. */
function extractDeclaredScope(middlewareNames: string[]): string | null {
  for (const name of middlewareNames) {
    const scopeMatch = /^requireScope\((.+)\)$/.exec(name);
    const captured = scopeMatch?.[1];
    if (captured) return captured;
  }
  return null;
}

function walkRouter(router: Router, mountPrefix: string, out: RouteDescriptor[]): void {
  for (const layer of router.stack) {
    if (layer.route) {
      const routePath = layer.route.path;
      const leafExpress = routePath === '/' ? '' : routePath;
      const leafOpenApi = routePath === '/' ? '' : routePath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const expressPath = mountPrefix + leafExpress || '/';
      const openApiPath = mountPrefix + leafOpenApi || '/';

      const routeLayers = layer.route.stack;
      const firstLayer = routeLayers[0];
      const method = firstLayer ? firstLayer.method : 'get';
      const middlewareNames = routeLayers.map((routeLayer) => routeLayer.name);

      out.push({
        method,
        expressPath,
        openApiPath,
        middlewareNames,
        hasBearerAuth: middlewareNames.includes('bearerAuth'),
        declaredScope: extractDeclaredScope(middlewareNames),
      });
    } else if (layer.name === 'router' && isMountedRouterHandle(layer.handle)) {
      const prefix = staticMountPrefix(layer.regexp);
      walkRouter(layer.handle, mountPrefix + prefix, out);
    }
    // Anything else (a plain middleware layer with neither a route nor a
    // mounted sub-router — none exist on v1Routes today) has nothing to
    // enumerate; skipped rather than guessed at.
  }
}

function discoverV1Routes(): RouteDescriptor[] {
  const routes: RouteDescriptor[] = [];
  walkRouter(v1Routes, '', routes);
  return routes;
}

// ─── Documented exemptions — table-driven, not a route allowlist ──────────
//
// This table does NOT decide which routes get checked (the walk above
// already enumerates every one, unconditionally). It only carves out
// specific, already-documented design decisions from checks (b)/(d) so this
// suite doesn't demand a scope or a pagination envelope from a route that
// was deliberately built without one. Check (a) — the OpenAPI entry itself
// — has NO exemptions: every route must be registered, no matter what.

interface RouteExemption {
  method: string;
  openApiPath: string;
  /** Why this route legitimately has no `requireScope(...)`. */
  noScopeReason?: string;
  /** Why this GET, despite having no `{param}` segment, is not a
   * collection/list route and so does not need `{ data, next_cursor }`. */
  notAListReason?: string;
}

const KNOWN_EXEMPTIONS: readonly RouteExemption[] = [
  {
    method: 'get',
    openApiPath: '/health',
    noScopeReason:
      'Public, unauthenticated liveness check (PF-001) — no bearerAuth at all, so no scope applies.',
    notAListReason: 'Returns a single { status } object (PF-001), not a collection.',
  },
  {
    method: 'get',
    openApiPath: '/openapi.json',
    noScopeReason:
      'Public, no auth, per PF-202\'s architect note ("public, no auth — PF-907 verifies public resolvability").',
    notAListReason: 'Returns the OpenAPI document itself — a single object, not a collection.',
  },
  {
    method: 'get',
    openApiPath: '/me',
    noScopeReason:
      'Deliberate PF-201 design decision (resources/me.ts header + me.test.ts\'s "no scope required" case) — a valid bearer token may call /me regardless of which scopes it was granted, matching GitHub/Google-style identity endpoints — bearerAuth alone is the complete authorization requirement.',
    notAListReason: 'Returns a single principal-identity object ({ user, app, scopes }), not a collection.',
  },
] as const;

function exemptionFor(method: string, openApiPath: string): RouteExemption | undefined {
  return KNOWN_EXEMPTIONS.find((e) => e.method === method && e.openApiPath === openApiPath);
}

// ─── OpenAPI document helpers ──────────────────────────────────────────────

function operationFor(pathItem: PathItemObject, method: string): OperationObject | undefined {
  switch (method) {
    case 'get':
      return pathItem.get;
    case 'post':
      return pathItem.post;
    case 'put':
      return pathItem.put;
    case 'delete':
      return pathItem.delete;
    case 'patch':
      return pathItem.patch;
    case 'options':
      return pathItem.options;
    case 'head':
      return pathItem.head;
    default:
      // A future route using a method this test hasn't seen yet — fail
      // loud rather than silently reporting "no OpenAPI entry".
      throw new Error(`route-fitness: unhandled HTTP method "${method}" — extend operationFor()`);
  }
}

function resolveSchema(
  schemaOrRef: SchemaObject | ReferenceObject | undefined,
  components: ComponentsObject | undefined
): SchemaObject | undefined {
  if (!schemaOrRef) return undefined;
  if (isReferenceObject(schemaOrRef)) {
    const name = schemaOrRef.$ref.replace('#/components/schemas/', '');
    const resolved = components?.schemas?.[name];
    if (!resolved || isReferenceObject(resolved)) return undefined;
    return resolved;
  }
  return schemaOrRef;
}

// ─── supertest dispatch (avoids a dynamic-string method-name cast) ────────

function supertestFor(app: Express, method: string, path: string): request.Test {
  const agent = request(app);
  switch (method) {
    case 'get':
      return agent.get(path);
    case 'post':
      return agent.post(path);
    case 'put':
      return agent.put(path);
    case 'delete':
      return agent.delete(path);
    case 'patch':
      return agent.patch(path);
    default:
      throw new Error(`route-fitness: unhandled HTTP method "${method}" — extend supertestFor()`);
  }
}

// ─── The suite ─────────────────────────────────────────────────────────────

describe('PF-203: /api/v1 route-enumeration fitness test (Linear TRO-404)', () => {
  const app = createApp();
  const routes = discoverV1Routes();

  it('sanity: the walk itself discovered the live router stack (not silently empty)', () => {
    // Not a hand-maintained "these are the routes" list — a floor so a
    // walker regression (e.g. a broken recursion) that finds zero routes
    // doesn't read as "0 checked, 0 failed" = green.
    const paths = routes.map((r) => `${r.method.toUpperCase()} ${r.openApiPath}`);
    expect(routes.length, `discovered routes: ${paths.join(', ')}`).toBeGreaterThanOrEqual(8);
  });

  describe.each(routes)('$method $openApiPath', (route) => {
    it('(a) has an OpenAPI entry, with security matching real bearerAuth presence', () => {
      const pathItem = getPath(v1OpenApiDocument.paths, route.openApiPath);
      const operation = pathItem ? operationFor(pathItem, route.method) : undefined;

      if (!operation) {
        throw new Error(
          `DRIFT: ${route.method.toUpperCase()} ${route.openApiPath} (Express path ${route.expressPath}) ` +
            'is mounted on v1Routes but has no v1Registry.registerPath entry in the generated ' +
            'v1OpenApiDocument. This is exactly the drift PF-203 exists to catch — see ' +
            'platform/openapi/schemas/documents.ts for the registration pattern, and add a ' +
            'sibling file under platform/openapi/schemas/ for this resource.'
        );
      }

      const declaresAuth = (operation.security?.length ?? 0) > 0;
      expect(
        declaresAuth,
        `${route.method.toUpperCase()} ${route.openApiPath}: registered OpenAPI security=` +
          `${JSON.stringify(operation.security)} does not match whether bearerAuth is actually ` +
          `wired on this route (${route.hasBearerAuth}).`
      ).toBe(route.hasBearerAuth);
    });

    it('(b) declares a scope via requireScope(...), or is a documented exemption', () => {
      const exemption = exemptionFor(route.method, route.openApiPath);

      if (exemption?.noScopeReason) {
        expect(
          route.declaredScope,
          `${route.method.toUpperCase()} ${route.openApiPath} is a documented no-scope exemption ` +
            `(${exemption.noScopeReason}) and must not gain a stray requireScope(...) — update the ` +
            'exemption table in route-fitness.test.ts if this route now needs one.'
        ).toBeNull();
        return;
      }

      expect(
        route.declaredScope,
        `DRIFT: ${route.method.toUpperCase()} ${route.openApiPath} has no requireScope(...) in its ` +
          `middleware stack (saw: ${route.middlewareNames.join(', ') || '(none)'}) and is not in the ` +
          'documented no-scope exemption table (KNOWN_EXEMPTIONS, route-fitness.test.ts). Every ' +
          '/api/v1 route must either declare a scope or be an explicitly documented exemption.'
      ).not.toBeNull();
      expect(
        route.hasBearerAuth,
        `${route.method.toUpperCase()} ${route.openApiPath} declares a scope via requireScope(...) ` +
          'but has no bearerAuth ahead of it — requireScope reads req.principal, which only ' +
          'bearerAuth sets (requireScope.ts).'
      ).toBe(true);
    });

    it('(c) its generic failure path returns the §2.5 ApiError shape', async () => {
      const probePath = '/api/v1' + route.expressPath.replace(/:[A-Za-z0-9_]+/g, 'route-fitness-probe');

      if (route.hasBearerAuth) {
        // No Authorization header. bearerAuth rejects this before touching
        // the database (oauth_tokens/api_tokens are only queried once a
        // 'Bearer ' prefix is present) — no fixtures needed.
        const res = await supertestFor(app, route.method, probePath);
        expect(res.status, `expected 401 for ${route.method.toUpperCase()} ${probePath} with no Authorization header, got ${res.status}: ${JSON.stringify(res.body)}`).toBe(401);
        expect(res.body.code).toBe('unauthorized');
        expect(typeof res.body.message).toBe('string');
        expect(res.body.message.length).toBeGreaterThan(0);
        expect(typeof res.body.request_id).toBe('string');
        expect(res.body.request_id.length).toBeGreaterThan(0);
      } else {
        // Public route: probe with a method it doesn't register. Falls
        // through to v1Router's notFoundHandler -> errorMiddleware, the
        // same catch-all AC-2 (error-middleware.test.ts) already proves
        // generally — applied here per-route.
        const probeMethod = (['delete', 'put', 'patch'] as const).find((m) => m !== route.method) ?? 'delete';
        const res = await supertestFor(app, probeMethod, probePath);
        expect(res.status, `expected 404 for ${probeMethod.toUpperCase()} ${probePath} (unsupported on this public route), got ${res.status}: ${JSON.stringify(res.body)}`).toBe(404);
        expect(res.body.code).toBe('not_found');
        expect(typeof res.body.request_id).toBe('string');
        expect(res.body.request_id.length).toBeGreaterThan(0);
      }
    });

    it('(d) paginates with { data, next_cursor } if it is a GET collection route, or is exempt', () => {
      const isCollectionShaped = route.method === 'get' && !route.openApiPath.includes('{');
      if (!isCollectionShaped) return; // writes and single-item GETs are never "a list"

      const exemption = exemptionFor(route.method, route.openApiPath);
      if (exemption?.notAListReason) return; // documented singleton GET

      const pathItem = getPath(v1OpenApiDocument.paths, route.openApiPath);
      const operation = pathItem ? operationFor(pathItem, route.method) : undefined;
      // Check (a) already reports a missing registration for this exact
      // route with its own diagnostic — don't double-report here.
      if (!operation) return;

      const okResponse = operation.responses?.['200'];
      const schema =
        okResponse && !isReferenceObject(okResponse)
          ? resolveSchema(okResponse.content?.['application/json']?.schema, v1OpenApiDocument.components)
          : undefined;

      const dataField = schema?.properties?.data;
      const dataIsArraySchema = dataField !== undefined && !isReferenceObject(dataField) && dataField.type === 'array';
      expect(
        dataIsArraySchema,
        `DRIFT: ${route.method.toUpperCase()} ${route.openApiPath} looks like a list route (GET, no ` +
          '{param} segment, not a documented singleton exemption) but its registered 200 response ' +
          `schema has no array-typed 'data' property (schema: ${JSON.stringify(schema)}).`
      ).toBe(true);

      expect(
        schema?.properties?.next_cursor,
        `DRIFT: ${route.method.toUpperCase()} ${route.openApiPath} is a list route with a 'data' array ` +
          "but its registered 200 response schema has no 'next_cursor' field."
      ).toBeDefined();
    });
  });
});
